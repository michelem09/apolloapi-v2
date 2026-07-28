const gql = require('graphql-tag');

module.exports = gql`
  extend type Query {
    Diagnostics: DiagnosticsActions
  }

  type DiagnosticsActions {
    bundle(input: DiagnosticsBundleInput): DiagnosticsBundleOutput! @auth
  }

  input DiagnosticsBundleInput {
    "Journal lines per unit (default 200, max 1000)."
    logLines: Int
  }

  type DiagnosticsBundleOutput {
    result: DiagnosticsBundleResult
    error: Error
  }

  type DiagnosticsBundleResult {
    "Suggested filename for the download."
    filename: String!
    "The bundle itself: pretty-printed JSON, already redacted."
    content: String!
    sizeBytes: Int!
    generatedAt: String!
  }
`;
