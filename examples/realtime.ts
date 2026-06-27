import {
  CradlewiseAuth,
  CradlewiseClient,
  CradlewiseRealtime,
  getAppConfig,
  isLegacyRealtimeSdkAvailable,
} from "../src/index.js";

if (process.env.CRADLEWISE_ENABLE_LEGACY_REALTIME !== "true") {
  throw new Error(
    "Set CRADLEWISE_ENABLE_LEGACY_REALTIME=true only for a verified legacy IAM-compatible account",
  );
}
if (!(await isLegacyRealtimeSdkAvailable()))
  throw new Error("Install the optional aws-iot-device-sdk-v2 peer dependency");

const email = process.env.CRADLEWISE_LOGIN;
const password = process.env.CRADLEWISE_PASSWORD;
if (!email || !password)
  throw new Error("Set CRADLEWISE_LOGIN and CRADLEWISE_PASSWORD");

const appConfig = await getAppConfig();
const auth = new CradlewiseAuth({ email, password, appConfig });
const client = new CradlewiseClient(auth);
const cradles = await client.discoverCradles();
const realtime = new CradlewiseRealtime({
  auth,
  client,
  cradleIds: cradles.keys(),
  allowLegacyIamAuthentication: true,
  onStateUpdate: () => console.log("Received a crib state update"),
});

realtime.on("error", console.error);
realtime.on("messageError", console.error);
await realtime.connect();
process.once(
  "SIGINT",
  () => void realtime.disconnect().finally(() => process.exit(0)),
);
