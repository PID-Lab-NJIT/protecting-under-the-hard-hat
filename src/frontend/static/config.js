/* PUTHH site configuration — single source of truth for external URLs.
   Loaded BEFORE script.js on every page. */
const PUTHH_CONFIG = {
  // AWS Lambda: survey submission
  SURVEY_ENDPOINT: 'https://nn6mnazknqfj6su7x5cm4svs640nmglc.lambda-url.us-east-2.on.aws/survey',
  // AWS Lambda: localized resources lookup
  LOCAL_RESOURCES_ENDPOINT: 'https://xo4yg2k32agti3frvpgix5sp5m0vemso.lambda-url.us-east-2.on.aws/local-resources',
  // Google Form: Order Materials (iframe appends ?embedded=true)
  GOOGLE_FORM_URL: 'https://docs.google.com/forms/d/e/1FAIpQLSdoVaKiy5ox6ErtL_uhSqXdXOWeDPP8hORkZtJDy7H_0FN2Sw/viewform',
  // Public-facing survey URL used in share/email text
  PUBLIC_SURVEY_URL: 'https://pid-lab-njit.github.io/protecting-under-the-hard-hat/questionnaire/',
  // Contact email (mailto target for Contact tab form + copy button)
  CONTACT_EMAIL: 'info@protectingunderthehardhat.org'
};
