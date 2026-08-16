#!/usr/bin/env node

import { runCli } from '../src/cli.js';

const exitCode = await runCli();
process.exitCode = exitCode;
