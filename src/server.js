const config = require('config');
const log = require('./logger')('server');

// Import the httpServer promise (wraps Express + Apollo + WebSocket)
const appPromise = require('./app');

const port = config.get('server.port');

appPromise.then(httpServer => {
  httpServer.listen(port, () => {
    log.info({ env: process.env.NODE_ENV || 'dev', port }, 'server listening');
  });
}).catch(error => {
  log.error({ err: error }, 'failed to initialize the app');
  process.exit(1);
});
