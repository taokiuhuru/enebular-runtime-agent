import * as fs from 'fs'
import * as path from 'path'
import objectHash from 'object-hash'

import AgentRunnerService from './agent-runner-service'
import Task from './task'
import { SSHConfig, SSH } from './ssh'
import { verifySignature } from '../utils'

interface RemoteLoginSettings {
  config: {
    enable: boolean
    localUser: string
    localServerPort: string
    localServerPublicKey: {
      id: string
      size: string
      signature: string
    }
    relayServer: string
    relayServerPort: string
    relayServerUser: string
    relayServerPrivateKey: {
      id: string
      size: string
      signature: string
    }
  }
  signature: string
  localServerPublicKeyData: string
  relayServerPrivateKeyData: string
}

export default class TaskRemoteLogin extends Task {
  public constructor(service: AgentRunnerService, settings: Record<string, any>) {
    super(service, 'remoteLogin', settings)
  }

  public async run(): Promise<void> {
    const settings = this._settings as RemoteLoginSettings
    const ssh = this._service.ssh
    const pubkey = fs.readFileSync(
      path.resolve(__dirname, '../../keys/enebular/pubkey.pem'),
      'utf8'
    )
    if (process.getuid() !== 0) {
      throw new Error(`RemoteLogin task requires root permission`)
    }

    if (!settings.config || !settings.signature) {
      throw new Error(`Invalid remote login settings`)
    }

    const hash = objectHash(settings.config, {
      algorithm: 'sha256',
      encoding: 'base64'
    })
    if (!verifySignature(hash, pubkey, settings.signature)) {
      throw new Error(`Invalid signature for config`)
    }

    let sshConfig: SSHConfig
    const config = settings.config
    if (!config.hasOwnProperty('enable')) {
      throw new Error(`enable is required for remote login config`)
    }

    if (config.enable) {
      if (
        !config.localUser ||
        !config.localServerPort ||
        !config.localServerPublicKey ||
        !config.relayServer ||
        !config.relayServerPort ||
        !config.relayServerUser ||
        !config.relayServerPrivateKey ||
        !settings.relayServerPrivateKeyData ||
        !settings.localServerPublicKeyData
      ) {
        throw new Error(`Missing parameters for enabling remote login`)
      }

      if (
        !verifySignature(
          settings.localServerPublicKeyData,
          pubkey,
          config.localServerPublicKey.signature
        )
      ) {
        throw new Error(`Invalid signature for localServerPublicKey`)
      }
      if (
        !verifySignature(
          settings.relayServerPrivateKeyData,
          pubkey,
          config.relayServerPrivateKey.signature
        )
      ) {
        throw new Error(`Invalid signature for relayServerPrivateKey`)
      }

      sshConfig = {
        enable: true,
        serverOptions: {
          user: config.localUser,
          port: config.localServerPort,
          publicKey: settings.localServerPublicKeyData
        },
        clientOptions: {
          user: config.localUser,
          localServerPort: config.localServerPort,
          remoteIPAddr: config.relayServer,
          remotePort: config.relayServerPort,
          remoteUser: config.relayServerUser,
          privateKey: settings.relayServerPrivateKeyData
        }
      }
    }
    else {
      sshConfig = {
        enable: false,
      }
    }
    ssh.setConfig(sshConfig)
  }

  public async cancel(): Promise<void> {}
}
