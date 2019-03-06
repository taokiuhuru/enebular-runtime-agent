import CommandLine from './command-line'
import Config from './config'
import Log from './log'
import AgentInfo from './agent-info'
import AgentVersion from './agent-version'
import { AgentInstaller, AgentInstallerIf } from './agent-installer'
import { Migrator, MigratorIf } from './migrator'
import { System, SystemIf } from './system'
import Utils from './utils'
import { version as updaterVer } from '../package.json'
import * as path from 'path'
import * as fs from 'fs'
import * as rimraf from 'rimraf'

export default class AgentUpdater {
  private _commandLine: CommandLine
  private _config: Config
  private _log: Log
  private _system: SystemIf
  private _installer?: AgentInstallerIf
  private _migrator?: MigratorIf

  public constructor(
    system?: SystemIf,
    installer?: AgentInstallerIf,
    migrator?: MigratorIf
  ) {
    this._config = new Config()
    this._config.importConfigStrings(process.env)

    this._commandLine = new CommandLine(this._config)
    this._commandLine.parse()
    this._config.importConfigAnyTypes(this._commandLine.getConfigOptions())

    this._log = new Log(
      this._config.getString('DEBUG'),
      this._config.getBoolean('ENEBULAR_AGENT_UPDATER_ENABLE_LOG')
    )

    this._system = system ? system : new System(this._log)
    this._installer = installer
    this._migrator = migrator
  }

  public getLogFilePath(): string {
    return this._log.getLogFilePath()
  }

  private _requireRootUser(user: string): void {
    this._log.info(
      'To update enebular-agent, copy/paste the following command:'
    )

    let appendEnvs = ''
    const overriddenItems = this._config.getOverriddenItems()
    const itemKeys = Object.keys(overriddenItems)
    itemKeys.forEach(key => {
      if (key !== 'ENEBULAR_AGENT_USER')
        appendEnvs = appendEnvs + ` ${key}='${overriddenItems[key].value}'`
    })

    this._log.info(
      'sudo env PATH=$PATH:' +
        path.dirname(process.execPath) +
        appendEnvs +
        ' ' +
        process.argv[1] +
        ` --user=${user}`
    )
  }

  private checkIfAgentDead(
    serviceName: string,
    initDelay: number,
    timeout: number,
    newAgent: boolean
  ): Promise<boolean> {
    return Utils.polling(
      async (): Promise<boolean> => {
        return newAgent
          ? this._system.isNewAgentDead(serviceName)
          : this._system.isAgentDead(serviceName)
      },
      initDelay,
      1000,
      timeout
    )
  }

  private async _startAgent(
    version: AgentVersion,
    path: string,
    user: string,
    serviceName: string,
    newAgent = true
  ): Promise<void> {
    const prefix = newAgent ? '' : '[RESTORE] '
    await Utils.taskAsync(
      `${prefix}Starting enebular-agent ${version}`,
      this._log,
      (): Promise<boolean> => {
        return newAgent
          ? this._system.startNewAgent(serviceName)
          : this._system.startAgent(serviceName)
      }
    )

    return Utils.taskAsync(
      `${prefix}Verifying enebular-agent ${version}`,
      this._log,
      async (): Promise<boolean> => {
        if (
          await this.checkIfAgentDead(
            serviceName,
            2000,
            this._config.getNumber('MINIMUM_CHECKING_TIME') * 1000,
            newAgent
          )
        ) {
          throw new Error(`Verification failed, ${version} failed to start!`)
        }
        return true
      }
    )
  }

  private _preupdateCheck(newAgentInfo: AgentInfo, agentInfo: AgentInfo): void {
    if (
      !newAgentInfo.version.greaterThan(agentInfo.version) &&
      !this._config.getBoolean('FORCE_UPDATE')
    ) {
      throw new Error(
        `enebular-agent is already the newest version (${
          agentInfo.version
        } => ${newAgentInfo.version})`
      )
    }
    if (agentInfo.systemd && agentInfo.systemd.port == 'pelion') {
      if (agentInfo.version.lessThan(new AgentVersion(2, 4, 0))) {
        throw new Error(
          `Updating enebular-agent pelion port is only supported from version 2.4.0`
        )
      }
      if (
        !agentInfo.version.greaterThan(new AgentVersion(2, 4, 0)) &&
        !this._config.isOverridden('PELION_MODE')
      ) {
        throw new Error(
          `Updating enebular-agent pelion port in 2.4.0 requires to set --pelion-mode (developer or factory)`
        )
      }
    }

    this._log.info(
      'Updating ' +
        Utils.echoGreen(`${agentInfo.version}`) +
        ' to ' +
        Utils.echoGreen(`${newAgentInfo.version}`)
    )
  }

  public async update(): Promise<boolean> {
    this._log.info('enebular-agent-updater version: ' + updaterVer)

    const user = this._config.getString('ENEBULAR_AGENT_USER')
    if (this._config.getBoolean('ROOT_REQUIRED') && process.getuid() !== 0) {
      this._requireRootUser(
        this._config.isOverridden('ENEBULAR_AGENT_USER')
          ? user
          : process.env.USER || user
      )
      throw new Error('You have to run this with root permission.')
    }

    let agentInfo
    // Detect where existing agent is
    Utils.task(
      'Checking enebular-agent in systemd',
      this._log,
      (): boolean => {
        agentInfo = AgentInfo.createFromSystemd(this._system, user)
        return true
      }
    )

    if (this._config.isOverridden('ENEBULAR_AGENT_INSTALL_DIR')) {
      // We are enforced to use user specified path
      agentInfo.path = this._config.getString('ENEBULAR_AGENT_INSTALL_DIR')
    } else {
      if (agentInfo.systemd && agentInfo.systemd.path) {
        agentInfo.path = agentInfo.systemd.path
      } else {
        // TODO: scan to find agent, now we only use default path
        agentInfo.path = this._config.getString('ENEBULAR_AGENT_INSTALL_DIR')
      }
    }

    const agentPath = agentInfo.path
    if (agentInfo.path != agentInfo.systemd.path) {
      Utils.task(
        `Checking enebular-agent by path (${agentInfo.path})`,
        this._log,
        (): void => {
          agentInfo = AgentInfo.createFromSrc(this._system, agentPath)
        }
      )
    }

    agentInfo.prettyStatus(this._log)

    // download and build new version
    const userInfo = Utils.getUserInfo(user)
    const newAgentDirName = 'enebular-runtime-agent.new'
    const cachePath = `/home/${user}`
    const newAgentInstallPath = path.resolve(cachePath, `./${newAgentDirName}`)
    this._installer = this._installer
      ? this._installer
      : new AgentInstaller(this._config, this._log, this._system)
    const newAgentInfo = await this._installer.install(
      newAgentInstallPath,
      userInfo
    )

    this._preupdateCheck(newAgentInfo, agentInfo)

    await this._installer.build(agentInfo, newAgentInfo, userInfo)

    const serviceName = agentInfo.systemd.serviceName
    const oldAgentDirName = 'enebular-runtime-agent.old'
    const oldAgentBackupPath = path.resolve(cachePath, `./${oldAgentDirName}`)
    let switched = false

    // setup and switch to the new agent
    try {
      // shutdown current agent
      if (agentInfo.systemd.active) {
        await Utils.taskAsync(
          `Stopping enebular-agent ${agentInfo.version}`,
          this._log,
          (): Promise<boolean> => {
            return this._system.stopAgent(serviceName)
          }
        )
      }
      // config copying, migrate
      if (this._migrator == undefined) {
        this._migrator = new Migrator(
          this._system,
          agentInfo,
          newAgentInfo,
          this._config,
          this._log,
          userInfo
        )
      }
      await this._migrator.migrate()

      await Utils.taskAsync(
        `Switching enebular-agent from ${agentInfo.version} to ${
          newAgentInfo.version
        }`,
        this._log,
        (): Promise<boolean> => {
          if (fs.existsSync(oldAgentBackupPath)) {
            rimraf.sync(oldAgentBackupPath)
          }
          return this._system.flipToNewAgent(
            newAgentInstallPath,
            agentPath,
            oldAgentBackupPath
          )
        }
      )

      switched = true
      await this._startAgent(newAgentInfo.version, agentPath, user, serviceName)
    } catch (err) {
      const version = agentInfo.version
      const newVersion = newAgentInfo.version
      try {
        this._log.debug(
          `${agentInfo.systemd.serviceName} status from journal:\n` +
            this._system.getServiceLogIgnoreError(
              agentInfo.systemd.serviceName,
              100
            )
        )
      } catch (err) {
        // ignore error if we have
      }
      // restore
      try {
        if (switched) {
          await Utils.taskAsync(
            `[RESTORE] Stopping enebular-agent ${newVersion}`,
            this._log,
            (): Promise<boolean> => {
              return this._system.stopNewAgent(serviceName)
            },
            true
          )

          await Utils.taskAsync(
            `[RESTORE] Flipping back to enebular-agent ${version}`,
            this._log,
            (): Promise<boolean> => {
              return this._system.flipToOriginalAgent(
                oldAgentBackupPath,
                agentPath,
                newAgentInstallPath
              )
            }
          )
        }

        await this._startAgent(version, agentPath, user, serviceName, false)
      } catch (err1) {
        throw new Error(
          err.message +
            `\n[Faulty] restore to ${version} failed! error message:\n${
              err1.message
            }`
        )
      }
      throw err
    }

    this._log.info(Utils.echoGreen('Update succeed ✔'))
    return true
  }

  public async cancel(): Promise<boolean> {
    this._log.info(Utils.echoYellow('Update canceled ✔'))
    return true
  }
}
