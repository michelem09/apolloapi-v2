const gql = require('graphql-tag');

module.exports = gql`
  extend type Query {
    Mqtt: MqttActions
  }

  # Anything that changes state is a mutation: Apollo Client re-executes queries on
  # a re-render, and a phantom re-fire must never save a config or open a browse
  # session on the broker.
  extend type Mutation {
    Mqtt: MqttMutations
  }

  type MqttActions {
    "Broker connection, output settings and input mappings (password never returned)."
    config: MqttConfigOutput! @auth

    "One-off probe of the MQTT broker with the given (or stored) credentials. Persists nothing."
    testConnection(input: MqttConfigInput!): MqttTestOutput! @auth

    "Subscribe to a wildcard for a few seconds and return the topics seen. Persists nothing."
    discoverTopics(input: MqttConfigInput!, prefix: String, seconds: Int): MqttDiscoverOutput! @auth

    """
    Topics the device's own broker connection has already seen (in-memory, bounded); no scan,
    and no side effect: it does not start or renew a browse session (Mutation.Mqtt.renewBrowse
    does). Not ok while disconnected. error set on an ok result means the broker refused #.
    """
    cachedTopics: MqttDiscoverOutput! @auth
  }

  type MqttMutations {
    updateConfig(input: MqttConfigInput!): MqttConfigOutput! @auth

    """
    Start or renew the browse session, during which the device listens to the # wildcard on
    the broker. It ends with endBrowse or after 5 minutes without a renewal. Not ok while
    disconnected.
    """
    renewBrowse: MqttTestOutput! @auth

    "End the browse session (the modal closed): stop listening to #. The cache is kept."
    endBrowse: MqttTestOutput! @auth
  }

  type MqttConfigOutput {
    result: MqttConfig
    error: Error
  }

  type MqttConfig {
    enabled: Boolean
    host: String
    port: Int
    username: String
    tls: Boolean
    "Live connection state of the broker link."
    status: MqttStatus
    "Publishing the device state to the broker (Home Assistant discovery)."
    output: MqttOutput
    "Topic → signal mappings; each becomes an input.<name> number signal for the automation."
    inputs: [MqttInput!]
  }

  type MqttStatus {
    connected: Boolean!
    error: String
  }

  type MqttOutput {
    "Publish the device state to the broker and announce it to Home Assistant."
    enabled: Boolean
    "Also expose command topics so Home Assistant can start/stop and set the mode."
    control: Boolean
    "Stable id used for the HA device and topic prefix (apollo/<deviceId>/…)."
    deviceId: String
    "Which domains to publish, one topic each."
    exports: MqttExports
  }

  type MqttExports {
    miner: Boolean
    node: Boolean
    solo: Boolean
    mcu: Boolean
  }

  type MqttInput {
    name: String!
    topic: String!
    "Optional dot-path into a JSON payload (e.g. 'solar.surplus')."
    jsonPath: String
    unit: String
  }

  type MqttTestOutput {
    result: MqttTestResult
    error: Error
  }

  type MqttTestResult {
    ok: Boolean!
    message: String
  }

  type MqttDiscoverOutput {
    result: MqttDiscoverResult
    error: Error
  }

  type MqttDiscoverResult {
    ok: Boolean!
    error: String
    topics: [MqttTopic!]!
  }

  type MqttTopic {
    topic: String!
    "A sample of the last payload (truncated)."
    sample: String
    "Dot-paths to numeric fields when the payload is JSON — candidate jsonPaths."
    jsonPaths: [String!]
    "Home Assistant discovery: friendly name of a resolved sensor value."
    name: String
    "Home Assistant discovery: unit of a resolved sensor value."
    unit: String
    "Home Assistant discovery: the single value path resolved from a sensor config."
    jsonPath: String
    "The current reading, if the topic has published one during the scan."
    value: String
    "Each entry of jsonPaths with its current value."
    pathValues: [MqttPathValue!]
    "When the topic (or, for an HA sensor, its value) was last seen, ISO 8601."
    lastSeen: String
  }

  type MqttPathValue {
    path: String!
    value: String
  }

  input MqttConfigInput {
    enabled: Boolean
    host: String
    port: Int
    username: String
    password: String
    tls: Boolean
    inputs: [MqttInputInput!]
    output: MqttOutputInput
  }

  input MqttOutputInput {
    enabled: Boolean
    control: Boolean
    exports: MqttExportsInput
  }

  input MqttExportsInput {
    miner: Boolean
    node: Boolean
    solo: Boolean
    mcu: Boolean
  }

  input MqttInputInput {
    name: String!
    topic: String!
    jsonPath: String
    unit: String
  }
`;
