#!/usr/bin/env node
require('../src/cli').main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e.message); process.exit(2); });
