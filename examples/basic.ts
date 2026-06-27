import {
  CradlewiseAuth,
  CradlewiseClient,
  getAppConfig,
} from "../src/index.js";

const email = process.env.CRADLEWISE_LOGIN;
const password = process.env.CRADLEWISE_PASSWORD;
if (!email || !password)
  throw new Error("Set CRADLEWISE_LOGIN and CRADLEWISE_PASSWORD");

const appConfig = await getAppConfig();
const auth = new CradlewiseAuth({ email, password, appConfig });
const client = new CradlewiseClient(auth);

for (const cradle of (await client.discoverCradles()).values()) {
  await client.updateCradle(cradle);
  console.log({
    online: cradle.online,
    statusPartial: cradle.statusPartial,
    unavailableStatusSources: cradle.unavailableStatusSources,
    babyPresent: cradle.babyPresent,
    sleepPhase: cradle.sleepPhaseName,
  });
}
