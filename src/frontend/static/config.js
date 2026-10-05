/* PUTHH site configuration — single source of truth for external URLs.
   Loaded BEFORE script.js on every page. */
const PUTHH_CONFIG = {
  // AWS Lambda: survey submission
  SURVEY_ENDPOINT: 'https://nn6mnazknqfj6su7x5cm4svs640nmglc.lambda-url.us-east-2.on.aws/survey',
  // AWS Lambda: localized resources lookup
  LOCAL_RESOURCES_ENDPOINT: 'https://xo4yg2k32agti3frvpgix5sp5m0vemso.lambda-url.us-east-2.on.aws/local-resources',
  // AWS Lambda: contact form (POST {name, email, message}; see src/backend/send_email/docs/spec.md)
  CONTACT_ENDPOINT: 'https://oc7tejhk2alopqzimzczp4hxlu0dynqb.lambda-url.us-east-2.on.aws/',
  // Google Sheets "Published to the web" CSV links (File → Share → Publish to web → CSV).
  // While empty, the site uses the bundled supporters.json / inline testimonies.
  SUPPORTERS_SHEET_URL: '',
  TESTIMONIES_SHEET_URL: '',
  // Google Form: Order Materials (iframe appends ?embedded=true)
  GOOGLE_FORM_URL: 'https://docs.google.com/forms/d/e/1FAIpQLSdoVaKiy5ox6ErtL_uhSqXdXOWeDPP8hORkZtJDy7H_0FN2Sw/viewform',
  // Public-facing survey URL used in share/email text
  PUBLIC_SURVEY_URL: 'https://pid-lab-njit.github.io/protecting-under-the-hard-hat/questionnaire/',
  // Contact email (mailto target for Contact tab form + copy button)
  CONTACT_EMAIL: 'info@protectingunderthehardhat.org'
};
