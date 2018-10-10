/* @flow */

import fs from 'fs'
import util from 'util'
import request from 'request'
import progress from 'request-progress'
import objectHash from 'object-hash'
import { delay } from './utils'
import type DeviceStateManager from './device-state-manager'
import type AgentManagerMediator from './agent-manager-mediator'
import type { Logger } from 'winston'

// todo: validate config

const moduleName = 'asset-man'

/**
 * Asset states:
 *   - notDeployed | deployed
 *   - deploying | deployFail
 *   - removing | removeFail
 */

/**
 * Reported asset states:
 *   - deployPending | deploying | deployed | deployFail
 *   - updatePending | updating | update-fail (todo)
 *   - removePending | removing | removeFail
 */

class Asset {
  _assetMan: AssetManager
  _type: string
  _id: string
  updateId: string
  config: {}
  state: string
  changeTs: string
  changeErrMsg: string
  pendingUpdateId: string
  pendingChange: string // (deploy|remove)
  pendingConfig: {}
  //  todo:
  //   - failCount

  constructor(
    type: string,
    id: string,
    updateId: string,
    config: {},
    state: string,
    assetMan: AssetManager
  ) {
    this._type = type
    this._id = id
    this.updateId = updateId
    this.config = config
    this.state = state
    this._assetMan = assetMan
    this.changeTs = Date.now()
  }

  _debug(msg: string, ...args: Array<mixed>) {
    this._assetMan._debug(msg, ...args)
  }

  _info(msg: string, ...args: Array<mixed>) {
    this._assetMan._info(msg, ...args)
  }

  _error(msg: string, ...args: Array<mixed>) {
    this._assetMan._error(msg, ...args)
  }

  _destDirPath() {
    return [this._assetMan._dataDir, this.config.destPath].join('/')
  }

  type() {
    return this._type
  }

  id() {
    return this._id
  }

  name() {
    return this.config.name
  }

  serialize(): {} {
    return {
      type: this._type,
      id: this._id,
      updateId: this.updateId,
      state: this.state,
      changeTs: this.changeTs,
      changeErrMsg: this.changeErrMsg,
      config: this.config
    }
  }

  // todo: hooks exec

  async deploy(): boolean {
    this._info(`Deploying asset '${this.name()}'...`)

    try {
      // Ensure dest directory exists
      const destDir = this._destDirPath()
      if (!fs.existsSync(destDir)) {
        this._debug('Creating directory for asset: ' + destDir)
        fs.mkdirSync(destDir)
      }

      // Acquire
      try {
        this._info('Acquiring asset...')
        await this._acquire()
      } catch (err) {
        throw new Error('Failed to acquire asset: ' + err.message)
      }
      this._info('Acquired asset')

      // Verify
      try {
        this._info('Verifying asset...')
        await this._verify()
      } catch (err) {
        throw new Error('Failed to verify asset: ' + err.message)
      }
      this._info('Verified asset')

      // Install
      try {
        this._info('Installing asset...')
        await this._install()
      } catch (err) {
        throw new Error('Failed to install asset: ' + err.message)
      }
      this._info('Installed asset')
    } catch (err) {
      this.changeErrMsg = err.message
      this._error(err.message)
      return false
    }

    this._info(`Deployed asset '${this.name()}'`)

    return true
  }

  async _acquire() {
    throw new Error('Called an abstract function')
  }

  async _verify() {
    throw new Error('Called an abstract function')
  }

  async _install() {
    throw new Error('Called an abstract function')
  }

  async remove(): boolean {
    this._info(`Removing asset '${this.name()}'...`)

    try {
      // Delete
      try {
        this._info('Deleting asset...')
        await this._delete()
      } catch (err) {
        throw new Error('Failed to delete asset: ' + err.message)
      }
      this._info('Deleted asset')

      // Clean up dest directory
      const destDir = this._destDirPath()
      if (fs.existsSync(destDir)) {
        this._debug('Removing asset directory: ' + destDir)
        fs.rmdirSync(destDir)
      }
    } catch (err) {
      this.changeErrMsg = err.message
      this._error(err.message)
      return false
    }

    this._info(`Removed asset '${this.name()}'`)

    return true
  }

  async _delete() {
    throw new Error('Called an abstract function')
  }
}

class FileAsset extends Asset {
  _filePath() {
    return [this._destDirPath(), this.config.fileTypeConfig.filename].join('/')
  }

  _key() {
    return this.config.fileTypeConfig.internalSrcConfig.key
  }

  async _acquire() {
    // Get asset file data download URL
    this._debug('Getting file download url...')
    const url = await this._assetMan._agentMan.getInternalFileAssetDataUrl(
      this._key()
    )
    this._debug('Got file download url')

    // Donwload asset file data
    const path = this._filePath()
    const onProgress = state => {
      this._debug(
        util.format(
          'progress: %f%% @ %fB/s, %fsec',
          state.percent ? state.percent.toPrecision(1) : 0,
          state.speed ? state.speed.toPrecision(1) : 0,
          state.time.elapsed ? state.time.elapsed.toPrecision(1) : 0
        )
      )
    }
    this._debug(`Dowloading ${url} to ${path} ...`)
    await new Promise(function(resolve, reject) {
      progress(request(url), {})
        .on('progress', onProgress)
        .on('error', err => {
          reject(err)
        })
        .on('end', () => {
          resolve()
        })
        .pipe(fs.createWriteStream(path))
    })
  }

  async _verify() {
    this._debug('todo: verify')
  }

  async _install() {
    this._debug('todo: install')
  }

  async _delete() {
    const path = this._filePath()
    this._debug(`Deleting ${path}...`)
    fs.unlinkSync(path)
  }
}

export default class AssetManager {
  _deviceStateMan: DeviceStateManager
  _agentMan: AgentManagerMediator
  _log: Logger
  _assets: Array<Asset> = []
  _processingChanges: boolean = false
  _inited: boolean = false
  _active: boolean = false
  _dataDir: string = 'asset-data' // tmp
  _stateFilePath: string = 'asset-state' // tmp

  constructor(
    deviceStateMan: DeviceStateManager,
    agentMan: AgentManagerMediator,
    log: Logger
  ) {
    this._deviceStateMan = deviceStateMan
    this._agentMan = agentMan
    this._log = log
    this._deviceStateMan.on('stateChange', params =>
      this._handleDeviceStateChange(params)
    )
  }

  _debug(msg: string, ...args: Array<mixed>) {
    args.push({ module: moduleName })
    this._log.debug(msg, ...args)
  }

  _info(msg: string, ...args: Array<mixed>) {
    args.push({ module: moduleName })
    this._log.info(msg, ...args)
  }

  _error(msg: string, ...args: Array<mixed>) {
    args.push({ module: moduleName })
    this._log.error(msg, ...args)
  }

  async setup() {
    if (this._inited) {
      return
    }

    if (!fs.existsSync(this._dataDir)) {
      fs.mkdirSync(this._dataDir)
    }

    await this._initAssets()

    this._inited = true
  }

  async _initAssets() {
    this._loadAssets()
    this._updateAssetsFromDesiredState()
    this._updateAssetsReportedState()
  }

  _loadAssets() {
    if (!fs.existsSync(this._stateFilePath)) {
      return
    }

    this._info('Loading asset state: ' + this._stateFilePath)

    const data = fs.readFileSync(this._stateFilePath, 'utf8')
    let serializedAssets = JSON.parse(data)
    for (let serializedAsset of serializedAssets) {
      let asset = this._deserializeAsset(serializedAsset)
      this._assets.push(asset)
    }
  }

  _deserializeAsset(serializedAsset): Asset {
    switch (serializedAsset.type) {
      case 'file':
        break
      default:
        throw new Error('Unsupported asset type: ' + serializedAsset.type)
    }

    let asset = new FileAsset(
      serializedAsset.type,
      serializedAsset.id,
      serializedAsset.updateId,
      serializedAsset.config,
      serializedAsset.state,
      this
    )
    asset.changeTs = serializedAsset.changeTs
    asset.changeErrMsg = serializedAsset.changeErrMsg

    return asset
  }

  _saveAssetState() {
    this._debug('Saving asset state...')

    let serializedAssets = []
    for (let asset of this._assets) {
      switch (asset.state) {
        case 'deployed':
        case 'deployFail':
        case 'removeFail':
          serializedAssets.push(asset.serialize())
          break
        default:
          break
      }
    }
    this._debug('Asset state: ' + JSON.stringify(serializedAssets, null, '\t'))
    try {
      fs.writeFileSync(
        this._stateFilePath,
        JSON.stringify(serializedAssets),
        'utf8'
      )
    } catch (err) {
      this._error('Failed to save asset state: ' + err.message)
    }
  }

  async _handleDeviceStateChange(params) {
    if (!this._inited) {
      return
    }

    if (params.path && !params.path.startsWith('assets')) {
      return
    }

    switch (params.type) {
      case 'desired':
        this._updateAssetsFromDesiredState()
        break
      case 'reported':
        this._updateAssetsReportedState()
        break
      default:
        break
    }
  }

  async _updateAssetsFromDesiredState() {
    const desiredState = this._deviceStateMan.getState('desired', 'assets')
    if (!desiredState || !desiredState.assets) {
      return
    }

    this._debug(
      'Assets state change: ' + JSON.stringify(desiredState, null, '\t')
    )

    // Determine assets requiring a 'deploy' change
    let newAssets = []
    for (const desiredAssetId in desiredState.assets) {
      if (!desiredState.assets.hasOwnProperty(desiredAssetId)) {
        continue
      }
      let desiredAsset = desiredState.assets[desiredAssetId]

      // Updates to existing assets
      let found = false
      for (let asset of this._assets) {
        if (asset.id() === desiredAssetId) {
          if (asset.updateId !== desiredAsset.updateId) {
            asset.pendingUpdateId = desiredAsset.updateId
            asset.pendingChange = 'deploy'
            asset.pendingConfig = desiredAsset.config
            asset.changeTs = Date.now()
          }
          found = true
          break
        }
      }

      // New assets
      if (!found) {
        let asset = null
        switch (desiredAsset.config.type) {
          case 'file':
            asset = new FileAsset(
              desiredAsset.config.type,
              desiredAssetId,
              null,
              null,
              'notDeployed',
              this
            )
            asset.pendingUpdateId = desiredAsset.updateId
            asset.pendingChange = 'deploy'
            asset.pendingConfig = desiredAsset.config
            break
          default:
            this._error('Unsupported asset type: ' + desiredAsset.config.type)
            break
        }
        if (asset) {
          newAssets.push(asset)
        }
      }
    }

    // Determine assets requiring a 'remove change
    for (let asset of this._assets) {
      if (!desiredState.assets.hasOwnProperty(asset.id())) {
        asset.pendingChange = 'remove'
        asset.changeTs = Date.now()
      }
    }

    // Append 'new' assets
    this._assets = this._assets.concat(newAssets)

    // this._debug('assets: ' + inspect(this._assets))

    this._updateAssetsReportedState()
    this._processPendingChanges()
  }

  _removeAssetReportedState(assetId) {
    this._debug(`Removing asset '${assetId}' reported state`)
    this._deviceStateMan.updateState(
      'reported',
      'remove',
      'assets.assets.' + assetId
    )
  }

  _getReportedAssetState(assetId: string): {} {
    const reportedState = this._deviceStateMan.getState('reported', 'assets')
    if (!reportedState || !reportedState.assets) {
      return null
    }

    return reportedState.assets[assetId]
  }

  // Only updates the reported state if required (if there is a difference)
  _updateAssetReportedState(asset) {
    // Create new reported state
    let state
    if (asset.pendingChange) {
      switch (asset.pendingChange) {
        case 'deploy':
          state = 'deployPending'
          break
        case 'remove':
          state = 'removePending'
          break
        default:
          state = 'unknown'
          break
      }
    } else {
      state = asset.state
    }
    let newStateObj = {
      ts: asset.changeTs,
      state: state
    }
    if (asset.changeErrMsg) {
      newStateObj.message = asset.changeErrMsg
    }
    newStateObj.updateId =
      asset.state === 'notDeployed' ? asset.pendingUpdateId : asset.updateId

    // Compare with currently reported state
    const currentStateObj = this._getReportedAssetState(asset.id())
    if (
      currentStateObj &&
      objectHash(currentStateObj) === objectHash(newStateObj)
    ) {
      this._debug(`Update of asset '${asset.id()}' reported state not required`)
      return
    }

    // Update if required
    this._debug(
      `Updating asset '${asset.id()}' reported state: ` +
        util.inspect(newStateObj)
    )
    this._deviceStateMan.updateState(
      'reported',
      'set',
      'assets.assets.' + asset.id(),
      newStateObj
    )
  }

  _updateAssetsReportedState() {
    const reportedState = this._deviceStateMan.getState('reported', 'assets')
    if (!reportedState) {
      return
    }

    this._debug(
      'Assets reported state: ' + JSON.stringify(reportedState, null, '\t')
    )

    if (reportedState.assets) {
      // Remove reported assets that no longer exist
      for (const reportedAssetId in reportedState.assets) {
        if (!reportedState.assets.hasOwnProperty(reportedAssetId)) {
          continue
        }
        let found = false
        for (let asset of this._assets) {
          if (asset.id() === reportedAssetId) {
            found = true
            break
          }
        }
        if (!found) {
          this._removeAssetReportedState(reportedAssetId)
        }
      }
    }

    // Update all current assets (if required)
    for (let asset of this._assets) {
      this._updateAssetReportedState(asset)
    }
  }

  _getFirstPendingChangeAsset(): Asset {
    if (this._assets.length < 1) {
      return null
    }
    for (let asset of this._assets) {
      if (asset.pendingChange) {
        return asset
      }
    }
    return null
  }

  _pendingChangeAssetExists(): boolean {
    return this._getFirstPendingChangeAsset() !== null
  }

  async _processPendingChanges() {
    if (!this._active || this._processingChanges) {
      return
    }
    this._processingChanges = true

    while (this._pendingChangeAssetExists()) {
      // Process simple 'remove' changes
      // todo: test this
      let removeAssets = this._assets.filter(asset => {
        return asset.pendingChange === 'remove' && asset.state === 'notDeployed'
      })
      this._assets = this._assets.filter(asset => {
        return !removeAssets.includes(asset)
      })
      for (let asset of removeAssets) {
        this._removeAssetReportedState(asset.id())
      }

      // Process remaining changes
      let asset = this._getFirstPendingChangeAsset()
      if (!asset) {
        continue
      }

      let pendingChange = asset.pendingChange
      asset.pendingChange = null

      switch (pendingChange) {
        case 'deploy':
          if (asset.state === 'deployed') {
            asset.state = 'removing'
            this._updateAssetReportedState(asset)
            let success = await asset.remove()
            if (!success) {
              asset.state = 'removeFail'
              break
            }
          }
          asset.updateId = asset.pendingUpdateId
          asset.config = asset.pendingConfig
          asset.pendingConfig = null
          asset.state = 'deploying'
          this._updateAssetReportedState(asset)
          let success = await asset.deploy()
          asset.state = success ? 'deployed' : 'deployFail'
          this._updateAssetReportedState(asset)
          break

        case 'remove':
          if (asset.state === 'deployed') {
            asset.state = 'removing'
            this._updateAssetReportedState(asset)
            let success = await asset.remove()
            if (!success) {
              asset.state = 'removeFail'
              break
            }
          }
          this._assets = this._assets.filter(a => {
            return a !== asset
          })
          this._removeAssetReportedState(asset.id())
          break

        default:
          this._error('Unsupported pending change: ' + pendingChange)
          break
      }

      this._saveAssetState()

      // A small deploy to guard against becoming a heavy duty busy loop
      await delay(2 * 1000)
    }

    this._processingChanges = false
  }

  activate(active: boolean) {
    if (active === this._active) {
      return
    }
    if (active && !this._inited) {
      throw new Error('Attempted to activate asset-man when not initialized')
    }
    this._active = active
    if (this._active) {
      this._processPendingChanges()
    }
  }
}
