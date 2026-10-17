const gql = require('graphql-tag');

module.exports = gql`
  extend type Query {
    Solo: SoloActions
  }

  type SoloActions {
    status: SoloStatusOutput! @auth
    # start/stop/restart: deprecated aliases for UI bundles that predate the
    # move. They keep @auth, so an alias is never an unauthenticated way to
    # drive the solo pool.
    start: SoloOutput!
      @auth
      @deprecated(
        reason: "start is a Mutation (Mutation.Solo.start); this query alias only serves pre-mutation UI bundles"
      )
    stop: SoloOutput!
      @auth
      @deprecated(
        reason: "stop is a Mutation (Mutation.Solo.stop); this query alias only serves pre-mutation UI bundles"
      )
    restart: SoloOutput!
      @auth
      @deprecated(
        reason: "restart is a Mutation (Mutation.Solo.restart); this query alias only serves pre-mutation UI bundles"
      )
    stats: SoloStatsOutput! @auth
  }

  # Side-effectful actions must NOT be queries: Apollo Client treats queries as
  # safe to re-execute.
  extend type Mutation {
    Solo: SoloMutations
  }

  type SoloMutations {
    start: SoloOutput! @auth
    stop: SoloOutput! @auth
    restart: SoloOutput! @auth
  }

  type SoloOutput {
    success: Boolean!
    error: Error
  }

  type SoloStatusOutput {
    result: SoloStatus
    error: Error
  }

  type SoloStatus {
    status: String
  }

  type SoloStatsOutput {
    result: SoloStats
    error: Error
  }

  type SoloStats {
    status: String
    pool: SoloStatsPool
    users: [SoloStatsUsers]
    blockFound: Boolean
    # The record kept in the database. SoloStatsPool.bestshare is ckpool's own
    # figure for the current run and goes back to zero whenever ckpool restarts;
    # this one only ever rises.
    bestShareEver: SoloBestShare
    error: Error
    timestamp: String
  }

  type SoloBestShare {
    value: Float
    at: String
  }

  type SoloStatsPool {
    runtime: Float
    lastupdate: Int
    Users: Int
    Workers: Int
    Idle: Int
    Disconnected: Int
    hashrate1m: String
    hashrate5m: String
    hashrate15m: String
    hashrate1hr: String
    hashrate6hr: String
    hashrate1d: String
    hashrate7d: String
    diff: Float
    accepted: Float
    rejected: Float
    bestshare: Float
    SPS1m: Float
    SPS5m: Float
    SPS15m: Float
    SPS1h: Float
  }

  type SoloStatsUsers {
    hashrate1m: String
    hashrate5m: String
    hashrate1hr: String
    hashrate1d: String
    hashrate7d: String
    lastshare: Int
    workers: Int
    shares: Float
    bestshare: Float
    bestever: Float
    authorised: Float
    worker: [SoloStatsWorker]
  }

  type SoloStatsWorker {
    workername: String
    hashrate1m: String
    hashrate5m: String
    hashrate1hr: String
    hashrate1d: String
    hashrate7d: String
    lastshare: Int
    shares: Float
    bestshare: Float
    bestever: Float
  }
`;
