/* @flow */
import fs from 'fs-extra'
import path from 'path'
import { execSync } from 'child_process'
import Config from './config'

const systemdTemplate =
  '[Unit]\n' +
  'Description=Enebular agent\n' +
  'Documentation=https://docs.enebular.com/\n' +
  'After=network.target network-online.target\n' +
  'Wants=network-online.target\n' +
  '\n' +
  '[Service]\n' +
  'User=%USER%\n' +
  'Environment=PATH=%NODE_PATH%:/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin\n' +
  '%APPEND_ENV%' +
  'PIDFile=%PID_PATH%\n' +
  '\n' +
  'ExecStart=%START_AGENT%\n' +
  'ExecStop=%STOP_AGENT%\n' +
  '\n' +
  '[Install]\n' +
  'WantedBy=multi-user.target network-online.target\n'

export default class Startup {
  static requireRootUser() {
    console.log('You have to run this with root permission.')
    process.exit(1)
  }

  static appendEnvironment(src: string, key: string, value: string) {
    console.log('\t' + key + ':' + value)
    return src + 'Environment=' + key + '=' + value + '\n'
  }

  static startupRegister(user: string, serviceName: string, config: Config) {
    if (process.getuid() !== 0) {
      Startup.requireRootUser()
    }

    let appendEnvs = ''
    const exposedVariables = config.getExposedVariables()
    const items = Object.keys(exposedVariables)
    items.forEach(function(key) {
      appendEnvs = Startup.appendEnvironment(
        appendEnvs,
        key,
        exposedVariables[key]
      )
    })

    let template = systemdTemplate
    let destination = '/etc/systemd/system/' + serviceName + '.service'
    let startAgentCommand = process.mainModule.filename + ' --enable-syslog'
    template = template
      .replace(/%APPEND_ENV%/g, appendEnvs)
      .replace(/%START_AGENT%/g, startAgentCommand)
      .replace(/%STOP_AGENT%/g, process.mainModule.filename + ' kill')
      .replace(/%NODE_PATH%/g, path.dirname(process.execPath))
      .replace(/%USER%/g, user)
      .replace(/%PID_PATH%/g, config.get('ENEBULAR_AGENT_PID_FILE'))

    try {
      fs.writeFileSync(destination, template)
    } catch (e) {
      console.error('Failure when trying to write startup script')
      console.error(e.message || e)
    }

    let commands = ['systemctl enable ' + serviceName]

    try {
      fs.readFileSync(config.get('ENEBULAR_AGENT_PID_FILE')).toString()
    } catch (e) {
      // if the daemon is not running start it.
      commands.push('systemctl start ' + serviceName)
      commands.push('systemctl daemon-reload')
      commands.push('systemctl status ' + serviceName)
    }

    commands.forEach(item => {
      console.log('Executing ' + item + '...')
      execSync(item, (err, stdout, stderr) => {
        console.log(stdout)
        console.log(stderr)
        if (err) {
          console.error(err)
        }
      })
    })
  }

  static startupUnregister(user: string, serviceName: string, config: Config) {
    if (!fs.existsSync('/etc/systemd/system/' + serviceName + '.service')) {
      console.error('No startup service has been registered.')
      return
    }

    if (process.getuid() !== 0) {
      Startup.requireRootUser()
    }

    let commands = [
      'systemctl stop ' + serviceName,
      'systemctl disable ' + serviceName,
      'rm /etc/systemd/system/' + serviceName + '.service'
    ]

    execSync(commands.join('&& '), (err, stdout, stderr) => {
      console.log(stdout)
      console.log(stderr)
      if (err) {
        console.error(err)
      }
    })
  }
}
