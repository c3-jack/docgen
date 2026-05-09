// Headless server — same as server.js but no browser auto-open
// Used by electron.js
process.env.NO_OPEN = '1';
require('./server.js');
