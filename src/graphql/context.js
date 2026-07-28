const jwt = require('jsonwebtoken');
const config = require('config');
const services = require('../services');
const { knex } = require('../db');
const log = require('../logger')('graphql');

async function createContext({ req }) {
  // Extract token from Authorization header
  const token = req.headers.authorization?.replace('Bearer ', '');

  // Create a base context
  const context = {
    knex,
    services,
    isAuthenticated: false,
    user: null
  };

  // If token exists, verify it
  if (token) {
    try {
      const decoded = jwt.verify(token, config.get('server.secret'), {
        audience: 'auth'
      });

      context.user = decoded;
      context.isAuthenticated = true;
    } catch (error) {
      // Token verification failed, but we'll continue with unauthenticated context.
      // warn, not debug: an expired token is routine, but a failed auth is the only
      // trace of credential probing in the journal, and it must not be silent at the
      // production level. Matches the WS path's 'WS auth failed'.
      log.warn({ err: error }, 'JWT verification failed');
    }
  }

  return context;
}

module.exports = { createContext };