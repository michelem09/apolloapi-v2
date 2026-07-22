const gql = require('graphql-tag');

module.exports = gql`
  extend type Query {
    Mcu: McuActions
  }

  type McuActions {
    stats: McuStatsOutput! @auth
    wifiScan: McuWifiScanOutput! @auth
    wifiConnect(input: McuWifiConnectInput!): McuWifiConnectOutput! @auth
    wifiDisconnect: McuWifiDisconnectOutput! @auth
    reboot: EmptyOutput! @auth
    shutdown: EmptyOutput! @auth
    version: McuAppVersionOutput! @auth
    update: EmptyOutput! @auth
    updateProgress: McuUpdateProgressOutput! @auth
    lastUpdate: McuLastUpdateOutput! @auth
    timezone: McuTimezoneOutput! @auth
    setTimezone(input: McuSetTimezoneInput!): McuTimezoneOutput! @auth
  }

  type McuTimezoneOutput {
    result: McuTimezoneResult
    error: Error
  }

  type McuTimezoneResult {
    "The system timezone, as timedatectl reports it (e.g. Europe/Rome)."
    timezone: String!
    "Every IANA zone this device accepts."
    available: [String!]!
  }

  input McuSetTimezoneInput {
    timezone: String!
  }

  type McuStatsOutput {
    result: McuStatsResult
    error: Error
  }

  type McuStatsResult {
    stats: McuStats!
  }

  type McuStats {
    timestamp: String!
    hostname: String
    operatingSystem: String
    uptime: String
    loadAverage: String
    architecture: String
    temperature: Int
    minerTemperature: Float
    minerFanSpeed: Int
    bfgminerLog: String
    activeWifi: String
    network: [NetworkStats!]
    memory: MemoryStats
    cpu: CpuStats
    disks: [DiskStats!]
  }

  type MemoryStats {
    total: Float
    available: Float
    used: Float
    cache: Float
    swap: Float
  }

  type CpuStats {
    threads: Int
    usedPercent: Float
  }

  type NetworkStats {
    name: String
    address: String
    mac: String
  }

  type DiskStats {
    total: Float
    used: Float
    mountPoint: String
  }

  type McuWifiScanOutput {
    result: McuWifiScanResult
    error: Error
  }

  type McuWifiScanResult {
    wifiScan: [McuWifiScan]
  }

  type McuWifiScan {
    ssid: String
    mode: String
    channel: Int
    rate: Int
    signal: Int
    security: String
    inuse: Boolean
  }

  input McuWifiConnectInput {
    ssid: String!
    passphrase: String
  }

  type McuWifiConnectOutput {
    result: McuWifiConnectResult
    error: Error
  }

  type McuWifiConnectResult {
    address: String!
  }

  type McuWifiDisconnectOutput {
    error: Error
  }

  type McuAppVersionOutput {
    """
    The version available to install, from the signed update channel. Keeps the
    name 'result' so a browser still running an older UI bundle goes on working
    while the two halves are swapped.
    """
    result: String
    "What this device is actually running, from the release it installed."
    installed: String
    "What the update channel offers, or null when it cannot be reached."
    available: String
    error: Error
  }

  type McuUpdateProgressOutput {
    result: McuUpdateProgressResult
    error: Error
  }

  type McuUpdateProgressResult {
    value: Int
  }

  type McuLastUpdateOutput {
    result: McuLastUpdateResult
    error: Error
  }

  """
  What the last update attempt did. The updater writes this to the state dir
  before it finishes, because progress is polled through this API and the updater
  stops this API — so the UI is disconnected for exactly the window that matters
  and reconnects with no memory of it. Null when no update has ever run.
  """
  type McuLastUpdateResult {
    "success | rolled-back | failed. 'failed' means the device was never modified."
    result: String!
    "Version installed before the attempt."
    from: String
    "Version the attempt was installing."
    to: String
    "Why it stopped, empty on success."
    reason: String
    startedAt: String
    finishedAt: String
  }
`;