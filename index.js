require('dotenv').config();
const fs = require('fs');
const readline = require('readline');
const Joi = require('joi');
const env = require('env-var');

// - ENVS
const APP_PORT = env.get('APP_PORT').default(3001).asInt();
const USE_WHITELIST = env.get('USE_WHITELIST').default('false').asBool();
const WHITELIST_ORIGIN = env.get('WHITELIST_ORIGIN').asString();
const GOOGLE_SERVICE_ACCOUNT = JSON.parse(env.get('GOOGLE_SERVICE_ACCOUNT').required().asString()).installed;
const GOOGLE_SERVICE_SCOPES = env.get('GOOGLE_SERVICE_SCOPES').default('calendar.events').asString();
const GOOGLE_SERVICE_REDIRECT_URI = env.get('GOOGLE_SERVICE_REDIRECT_URI').required().asString();

// - EXPRESS
const express = require("express");
const app = express();

// - GOOGLE AUTH
const { google } = require("googleapis");
const oAuth2Client = new google.auth.OAuth2(
  GOOGLE_SERVICE_ACCOUNT.client_id,
  GOOGLE_SERVICE_ACCOUNT.client_secret,
  GOOGLE_SERVICE_REDIRECT_URI
);

// - OAuth Perform
const TOKEN_PATH = 'token.json';
let calendar;
fs.readFile(TOKEN_PATH, (err, token) => {
  if (err) {
    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: GOOGLE_SERVICE_SCOPES.split(',').map((service) => `https://www.googleapis.com/auth/${service}`),
    });
    console.log('Authorize this app by visiting this url:', authUrl);
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    return rl.question('Enter the code from that page here: ', (code) => {
      rl.close();
      oAuth2Client.getToken(code, (err, token) => {
        if (err) return console.error('Error retrieving access token', err);
        oAuth2Client.setCredentials(token);
        fs.writeFile(TOKEN_PATH, JSON.stringify(token), (err) => {
          if (err) return console.error(err);
          console.log('Token stored to', TOKEN_PATH);
        });
        calendar = google.calendar({version: 'v3', auth: oAuth2Client});
      });
    });
  };
  oAuth2Client.setCredentials(JSON.parse(token));
  calendar = google.calendar({version: 'v3', auth: oAuth2Client});
});

// - CONST
const validResponses = ['needsAction', 'declined', 'tentative', 'accepted'];

// - MIDDLEWARE
app.use(
  require("morgan")(":method :url :status - :response-time ms (via :referrer)")
);
app.use(express.json());
app.use(require("cors")((req, callback) => {
  let opts;
  const origin = req.headers.origin;
  const whitelistUrls = WHITELIST_ORIGIN.split(',');
  if (whitelistUrls.indexOf(origin) !== -1 || !USE_WHITELIST) {
    opts = { origin: true };
  } else {
    opts = { origin: false };
  }
  callback(null, opts);
}));

// - ENDPOINTS
app.get("/", async (req, res) => {
  res.redirect("https://github.com/hrz8/opencalendar#readme");
});

app.post("/send/:event", async (req, res) => {
  const paramsSchema = Joi.object({
    event: Joi.string().required(),
  });
  const bodySchema = Joi.object({
    recipient: Joi.string().required(),
    response: Joi.string().valid(...validResponses)
  });
  
  try {
    await paramsSchema.validateAsync(req.params);
    await bodySchema.validateAsync(req.body);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'validation error'}); 
  }

  try {
    const { event: eventId } = req.params;
    const { recipient, response } = req.body;

    const { data: event } = await calendar.events.get({
      calendarId: 'primary',
      eventId
    });

    event.attendees = [
      ...event.attendees, {
        email: recipient,
        responseStatus: response || 'needsAction'
      }
    ];

    const updatedEvent = await calendar.events.patch({
      calendarId: 'primary',
      eventId,
      resource: event
    });
    return res.json({
      id: updatedEvent?.data?.id,
      htmlLink: updatedEvent?.data?.htmlLink,
      responseURL: updatedEvent?.request?.responseURL,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/create", async (req, res) => {
  // https://developers.google.com/calendar/api/v3/reference/events/insert#examples
  const timeSchema = Joi.object({
    dateTime: Joi.date().required(),
    timeZone: Joi.string().required()
  });
  const attendeeSchema = Joi.object({
    email: Joi.string().email({ tlds: { allow: false } }),
    responseStatus: Joi.string().valid(...validResponses)
  });
  const schema = Joi.object({
    summary: Joi.string().required(),
    location: Joi.string().required(),
    description: Joi.string().required(),
    start: timeSchema,
    end: timeSchema,
    attendees: Joi.array().items(attendeeSchema),
    reminders: Joi.object()
  });
  
  try {
    await schema.validateAsync(req.body);
  } catch (error) {
    return res.status(400).json({ error: error.message || 'validation error'}); 
  }

  try {
    const resource = req.body;
    const event = await calendar.events.insert({
      calendarId: 'primary',
      resource
    });
  
    return res.json({
      id: event?.data?.id,
      htmlLink: event?.data?.htmlLink,
      responseURL: event?.request?.responseURL,
    });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

// - APP START
app.listen(process.env.PORT || APP_PORT, () => console.log(`http://localhost:${APP_PORT}`));

// Avoid a single error from crashing the server in production.
process.on("uncaughtException", (...args) => console.error(args));
process.on("unhandledRejection", (...args) => console.error(args));
