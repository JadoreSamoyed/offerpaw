const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Keep parallel app/API development usable on ordinary laptops.
config.maxWorkers = 2;
module.exports = config;
