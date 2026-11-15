#!/usr/bin/env node
import { embeddingWorkerMain } from '../dist/workers/embedding-worker-cli.js';
await embeddingWorkerMain();
