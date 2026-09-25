const { ApolloServer } = require('@apollo/server');
const { expressMiddleware } = require('@apollo/server/express4');
const { useServer } = require('graphql-ws/use/ws');
const { WebSocketServer } = require('ws');
const { json } = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const config = require('config');
const schema = require('../graphql/schema');
const { createContext } = require('../graphql/context');
const { knex } = require('../db');
const services = require('../services');

async function setupApolloServer(app, httpServer) {
  // Create Apollo Server (HTTP)
  const server = new ApolloServer({
    schema,
    formatError: (error) => ({
      message: error.message,
      path: error.path,
      extensions: error.extensions
    })
  });

  await server.start();

  // WebSocket server — shares the same port/path as Apollo HTTP
  const wss = new WebSocketServer({ server: httpServer, path: '/api/graphql' });

  useServer(
    {
      schema,
      // Authenticate the WS connection using the JWT passed in connectionParams.
      //
      // Returning false rather than throwing, and the difference is visible to the
      // user: a throw is caught by graphql-ws and closed as 4500 "Internal server
      // error", which the client can only read as "the backend is broken" — so a
      // refused token produced a full-screen "backend offline" on a device that was
      // answering perfectly well. `false` closes with 4403 Forbidden, which says
      // what actually happened and which the client turns into a trip to sign in.
      onConnect: async (ctx) => {
        const authHeader = ctx.connectionParams?.authorization || '';
        const token = authHeader.replace('Bearer ', '').trim();

        if (!token) {
          console.warn('[WS] connection refused: no token');
          return false;
        }

        try {
          const user = jwt.verify(token, config.get('server.secret'), {
            audience: 'auth',
          });

          console.log(`[WS] Client connected, user: ${user.username || user.sub || 'unknown'}`);

          // Trigger an immediate data push ~1s after connection so the client
          // gets data right away without waiting for the next scheduler tick.
          // The delay lets all 6 subscription async iterators register before the first publish.
          setTimeout(() => {
            // Import lazily to avoid circular dependency at module load time
            const { pushAllStats } = require('./scheduler');
            pushAllStats();
          }, 1000);

          return { user };
        } catch (err) {
          console.warn('[WS] connection refused: invalid token:', err.message);
          return false;
        }
      },
      onDisconnect: (ctx) => {
        console.log('[WS] Client disconnected');
      },
      // Build the GraphQL execution context for each subscription operation
      context: (ctx) => ({
        knex,
        services,
        isAuthenticated: !!ctx.extra?.user,
        user: ctx.extra?.user,
      }),
    },
    wss
  );

  // Apply Apollo HTTP middleware (unchanged — handles queries and mutations)
  app.use(
    '/api/graphql',
    cors(),
    json(),
    expressMiddleware(server, {
      context: createContext
    })
  );

  return app;
}

module.exports = setupApolloServer;
