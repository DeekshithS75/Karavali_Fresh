module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    // EAS file variables provide a runner-local path; local development keeps
    // using the project's Firebase config file.
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON || config.android?.googleServicesFile || './google-services.json',
  },
});
