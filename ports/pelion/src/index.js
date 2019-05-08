/* @flow */
import PelionConnector from './pelion-connector'

const pelionConnector = new PelionConnector()

async function startup() {
  return pelionConnector.startup()
}

async function shutdown() {
  return pelionConnector.shutdown()
}

async function exit() {
  await shutdown()
  process.exit(0)
}

if (require.main === module) {
  process.on('SIGINT', () => {
    exit()
  })
  process.on('SIGTERM', () => {
    exit()
  })
  process.on('uncaughtException', err => {
    console.error(`Uncaught exception: ${err.stack}`)
    process.exit(1)
  })

  startup()
    .then(ret => {
      if (!ret) {
        process.exit(1)
      }
    })
    .catch(err => {
      console.error(`Agent startup failed: ${err}`)
      process.exit(1)
    })
}

export { startup, shutdown }