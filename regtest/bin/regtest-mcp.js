#!/usr/bin/env node
require('../src/mcp').main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
