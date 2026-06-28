export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue | undefined;
}

export interface AppConfigData {
  cognitoUserPoolId: string;
  cognitoAppClientId: string;
  cognitoAppClientSecret: string;
  cognitoIdentityPoolId: string;
  cognitoRegion: string;
  apiBaseUrl: string;
  iotEndpoint?: string;
}

export interface CradlewiseTokens {
  accessToken: string;
  idToken: string;
  refreshToken?: string;
  expiresAt: Date;
}

export interface CradlewiseAwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiration: Date;
}

export interface CradlewiseCredentials {
  tokens: CradlewiseTokens;
  aws: CradlewiseAwsCredentials;
  identityId: string;
}

export interface BabyProfile extends JsonObject {
  baby_id?: string | number;
  id?: string | number;
  name?: string | null;
}

export interface CradleRecord extends JsonObject {
  cradle_id?: string;
  timezone?: string | null;
}

export interface UserDeviceInfo extends JsonObject {
  device_id?: string | null;
  last_connected_time?: number | null;
}

export interface UserDeviceEntry extends JsonObject {
  email_id?: string | null;
  devices?: UserDeviceInfo[] | null;
}

export interface UserDevicesResponse extends JsonObject {
  no_of_devices?: number | null;
  user_devices?: UserDeviceEntry[] | null;
}

export interface CradleState extends JsonObject {
  babyPresent?: boolean;
  baby_present?: boolean;
  babySleepState?: string;
  baby_sleep_state?: string;
  babySleepPhase?: string | number;
  babySleepPhaseV2?: JsonObject & { eventValue?: number | string };
  babyNeedsAttention?: boolean;
  babyNeedsHelp?: boolean;
  isCribHelping?: boolean;
  loudSoundDetected?: boolean;
  insideSleepSchedule?: boolean;
  insideSoothingWindow?: boolean;
  rockingNotEffective?: boolean;
  mode?: string;
  userSetCradleMode?: string;
  detectedCradleMode?: string;
  bounceMode?: string | number;
  bounceSetting?: string | number;
  bounce_setting?: string | number;
  responsivitySetting?: string | number;
  responsivity_setting?: string | number;
  musicMode?: string | number;
  actuator?: JsonObject & { on?: boolean; amplitude?: number | string };
  music?: JsonObject & {
    play?: boolean | null;
    volume?: number | string | null;
    mood?: string;
  };
  soundSynth?: JsonObject & {
    play?: boolean;
    volume?: number | string;
    trackName?: string;
  };
  light?: JsonObject & { lightOn?: boolean; lightIntensity?: number | string };
  deviceStatus?: JsonObject & {
    batteryLife?: number | string;
    charging?: boolean;
    supplyRemoved?: boolean;
  };
  sleepTime?: string;
  wakeUpTime?: string;
  rawShadow?: JsonObject;
}

export interface InboxMessage extends JsonObject {
  message_id?: number | null;
  message_time?: string | null;
  message_type?: string | null;
  title?: string | null;
  body?: string | null;
  content_url?: string | null;
  thumbnail_url?: string | null;
  presentation_image_url?: string | null;
  content_type?: string | null;
}

export interface InboxMessagesResponse extends JsonObject {
  baby_notifications?: InboxMessage[] | null;
  cradlewise_notifications?: InboxMessage[] | null;
  enable_red_dot?: boolean | null;
  all_tags?: string[] | null;
  eol_message?: string | null;
}

export interface CradlePhoto {
  url: string;
  messageId?: number;
  messageTime?: string;
  title?: string;
  contentType?: string;
}

export interface SleepEvent extends JsonObject {
  event_time?: string | null;
  event_value?: string | number | null;
  soothe_count?: string | number | null;
}

export interface SleepDataRangeOptions {
  startDate?: Date | string;
  endDate?: Date | string;
  timezone?: string;
}

export interface SleepEventsResponse extends JsonObject {
  events: SleepEvent[];
  timezone?: string;
  sleep_sessions_saved?: string[];
}

export interface SleepAnalyticsQuery extends SleepDataRangeOptions {
  metricName?: string;
  metricFilter?: string;
  startHour?: number;
}

export interface SleepMetricMultiValue extends JsonObject {
  date?: string | null;
  value?: number[] | null;
}

export interface SleepMetricValue extends JsonObject {
  date?: string | null;
  value?: number | null;
}

export interface SleepAnalyticsResponse extends JsonObject {
  total_sleep?: string | number | null;
  total_awake?: string | number | null;
  soothe_count?: string | number | null;
  sleep_sessions?: SleepMetricMultiValue[] | null;
  awake_sessions?: SleepMetricMultiValue[] | null;
  successful_bounce_count?: SleepMetricValue[] | null;
  auto_soothe_events?: string[] | null;
  auto_soothe_counts?: number | null;
  timezone?: string | null;
}

export interface SleepAnalyticsData {
  totalSleepMinutes: number;
  totalAwakeMinutes: number;
  totalSootheCount: number;
  napCount: number;
  longestNapMinutes: number;
  lastNapStart?: string;
  lastNapEnd?: string;
  lastEventTime?: string;
  lastEventValue?: string;
  events: SleepEvent[];
  partial: boolean;
  unavailableSources: SleepAnalyticsSource[];
}

export type SleepAnalyticsSource = "events" | "analytics";

export interface CradlewiseClientOptions {
  fetch?: typeof fetch;
  userAgent?: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  allowStateChangingRequests?: boolean;
}

export type StateUpdateHandler = (cradleId: string, state: CradleState) => void;

export type CradleStatusSource = "state" | "online" | "firmware";
