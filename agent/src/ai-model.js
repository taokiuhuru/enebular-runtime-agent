/* @flow */

import crypto from 'crypto'
import diskusage from 'diskusage'
import fs from 'fs'
import path from 'path'
import request from 'request'
import progress from 'request-progress'
import util from 'util'
import extract from 'extract-zip'
import Asset from './asset'
import type DockerManager from './docker-manager'

export default class AiModel extends Asset {
  _fileName(): string {
    return this.config.fileTypeConfig.filename
  }

  _size(): string {
    return this.config.fileTypeConfig.size
  }

  /** @override */
  _destDirPath(): string {
    if (!this.config.destPath) {
      return this._assetMan.aiModelDir()
    }
    return path.join(this._assetMan.aiModelDir(), this.config.destPath)
  }

  _fileSubPath(): string {
    if (!this.config.destPath) {
      return this.config.fileTypeConfig.filename
    }
    return path.join(this.config.destPath, this.config.fileTypeConfig.filename)
  }

  _filePath(): string {
    return path.join(this._destDirPath(), this.config.fileTypeConfig.filename)
  }

  _mountPath(): string {
    return path.join(this._destDirPath(), 'mount')
  }

  _key(): string {
    return this.config.fileTypeConfig.internalSrcConfig.key
  }

  _handlers(): Array<Object> {
    return this.config.handlers
  }

  _existingContainer(): boolean {
    return this.config.existingContainer
  }

  _cores(): number {
    return this.config.cores
  }

  _cacheSize(): number {
    return this.config.cacheSize
  }

  _dockerImage(): string {
    return this.config.dockerImageUrl
  }

  _mainFilePath(): string {
    return this.config.mainFilePath
  }

  _language(): string {
    return this.config.language
  }

  _inputType(): boolean {
    return this.config.inputType
  }

  _wrapperUrl(): string {
    return this.config.wrapperUrl
  }

  _mainFileDir(): string {
    let mainFileDir = this._mainFilePath().split('.')
    if (mainFileDir.length > 1) {
      mainFileDir = mainFileDir.slice(0, -1)
    }
    return path.join(...mainFileDir)
  }

  _wrapperPath(): string {
    return path.join(
      this._destDirPath(),
      'mount',
      this._mainFileDir(),
      'wrapper.py'
    )
  }

  _dockerMan(): DockerManager {
    return this._assetMan._dockerMan
  }

  async _getIntegrity(path: string) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256')
      const file = fs.createReadStream(path)
      file.on('data', data => {
        hash.update(data)
      })
      file.on('end', () => {
        const digest = hash.digest('base64')
        resolve(digest)
      })
      file.on('error', err => {
        reject(err)
      })
    })
  }

  async _acquire() {
    // Check FS free space
    this._debug('Checking free space...')
    let usageInfo
    try {
      usageInfo = diskusage.checkSync(this._destDirPath())
    } catch (err) {
      throw new Error('Failed to get free space: ' + err.message)
    }
    if (usageInfo.free < this._size()) {
      throw new Error(
        `Not enough storage space (available: ${
          usageInfo.free
        }B, required: ${this._size()}B)`
      )
    }

    // Get asset file data download URL
    this._debug('Getting file download URL...')
    const url = await this._assetMan.agentMan.getInternalFileAssetDataUrl(
      this._key()
    )
    this._debug('Got file download URL')

    // Download asset file data
    const path = this._filePath()
    const onProgress = state => {
      this._info(
        util.format(
          'Download progress: %f%% @ %fKB/s, %fsec',
          state.percent ? Math.round(state.percent * 100) : 0,
          state.speed ? Math.round(state.speed / 1024) : 0,
          state.time.elapsed ? Math.round(state.time.elapsed) : 0
        )
      )
    }
    this._debug(`Downloading model ${url} to ${path} ...`)
    const that = this
    await new Promise(function(resolve, reject) {
      const fileStream = fs.createWriteStream(path)
      fileStream.on('error', err => {
        reject(err)
      })
      progress(request(url), {
        delay: 5000,
        throttle: 5000
      })
        .on('response', response => {
          that._debug(
            `Response: ${response.statusCode}: ${response.statusMessage}`
          )
          if (response.statusCode >= 400) {
            reject(
              new Error(
                `Error response: ${response.statusCode}: ${
                  response.statusMessage
                }`
              )
            )
          }
        })
        .on('progress', onProgress)
        .on('error', err => {
          reject(err)
        })
        .on('end', () => {
          resolve()
        })
        .pipe(fileStream)
    })
  }

  async _verify() {
    this._debug('Checking file integrity...')
    const integrity = await this._getIntegrity(this._filePath())
    if (integrity !== this.config.fileTypeConfig.integrity) {
      throw new Error(
        'File integrity mismatch: expected:' +
          this.config.fileTypeConfig.integrity +
          ', calculated:' +
          integrity
      )
    }
    this._info('File integrity matched: ' + integrity)
  }

  async _install() {
    fs.chmodSync(this._filePath(), 0o740)
    this._info('File installed to: ' + this._fileSubPath())
    // Extract archived model
    const that = this
    const path = this._filePath()
    const dest = this._mountPath()
    const onProgress = state => {
      this._info(
        util.format(
          'Download progress: %f%% @ %fKB/s, %fsec',
          state.percent ? Math.round(state.percent * 100) : 0,
          state.speed ? Math.round(state.speed / 1024) : 0,
          state.time.elapsed ? Math.round(state.time.elapsed) : 0
        )
      )
    }
    await new Promise((resolve, reject) => {
      this._info(`extracting archive ${this._fileName()} to ${dest}`)
      extract(path, { dir: dest }, err => {
        if (err) {
          this._error('extraction failed')
          reject(err)
        }
        this._info('extraction complete')
        resolve()
      })
    })

    // Downloading wrapper
    const wrapperUrl = this._wrapperUrl()
    const wrapperPath = this._wrapperPath()
    this._debug(`Downloading wrapper ${wrapperUrl} to ${wrapperPath} ...`)
    await new Promise(function(resolve, reject) {
      const fileStream = fs.createWriteStream(wrapperPath)
      fileStream.on('error', err => {
        reject(err)
      })
      progress(request(wrapperUrl), {
        delay: 5000,
        throttle: 5000
      })
        .on('response', response => {
          that._debug(
            `Response: ${response.statusCode}: ${response.statusMessage}`
          )
          if (response.statusCode >= 400) {
            reject(
              new Error(
                `Error response: ${response.statusCode}: ${
                  response.statusMessage
                }`
              )
            )
          }
        })
        .on('progress', onProgress)
        .on('error', err => {
          reject(err)
        })
        .on('end', () => {
          resolve()
        })
        .pipe(fileStream)
    })
  }

  // async _execFile() {
  //   this._info('Executing file...')
  //   this._info(
  //     'File command: ' +
  //       this._execInCmdForm(
  //         this._fileSubPath(),
  //         this._execArgs(),
  //         this._execEnvs()
  //       )
  //   )

  //   const args = this._execArgsArray(this._execArgs())
  //   const env = this._execEnvObj(this._execEnvs())
  //   const cwd = this._destDirPath()
  //   const that = this
  //   await new Promise((resolve, reject) => {
  //     const cproc = spawn(that._filePath(), args, {
  //       stdio: 'pipe',
  //       env: env,
  //       cwd: cwd
  //     })
  //     const timeoutID = setTimeout(() => {
  //       that._info('Execution went over time limit')
  //       cproc.kill()
  //     }, that._execMaxTime() * 1000)
  //     cproc.stdout.on('data', data => {
  //       let str = data.toString().replace(/(\n|\r)+$/, '')
  //       that._info('Asset: ' + str)
  //     })
  //     cproc.stderr.on('data', data => {
  //       let str = data.toString().replace(/(\n|\r)+$/, '')
  //       that._info('Asset: ' + str)
  //     })
  //     cproc.on('error', err => {
  //       clearTimeout(timeoutID)
  //       reject(err)
  //     })
  //     cproc.once('exit', (code, signal) => {
  //       clearTimeout(timeoutID)
  //       if (code !== null) {
  //         if (code === 0) {
  //           resolve()
  //         } else {
  //           reject(new Error('Execution ended with failure exit code: ' + code))
  //         }
  //       } else {
  //         reject(new Error('Execution ended with signal: ' + signal))
  //       }
  //     })
  //   })

  //   this._debug('Executed file')
  // }

  async _runPostInstallOps() {
    this._info('==============DOCKER STUFF==================')
    // this._dockerMan().listContainers()
    this._info('==============DOCKER IMAGE============', this._dockerImage())
    await this._dockerMan()
      .pullImage(this._dockerImage())
      .then(res =>
        this._dockerMan()
          .createContainer(this._dockerImage(), {
            cmd: ['/bin/bash'],
            mounts: [`${this._mountPath()}:/model`],
            ports: {
              '1234/tcp': '1234'
            }
          })
          .then(async container => {
            // await container.start()
            // const exec = await container.exec({
            //   Cmd: ['bash', '-c', 'echo Hello Container && ls'],
            //   AttachStdout: true,
            //   AttachStderr: true
            // })
            await this._dockerMan().exec(container, {
              Cmd: ['python', '-u', `/model/${this._mainFileDir()}/wrapper.py`],
              AttachStdout: true,
              AttachStderr: true
            })
            // this._info('EXEC', exec)
            setTimeout(() => this._dockerMan().listContainers(), 5000)
            // exec.inspect()
            // const smh = await exec.inspect()
            // this._info('INSPECT', smh)
          })
      )
    // INSTALLING OF DOCKER SHOULD BE HERE
  }

  async _delete() {
    const path = this._filePath()
    if (fs.existsSync(path)) {
      this._debug(`Deleting ${path}...`)
      fs.unlinkSync(path)
    }
  }
}
