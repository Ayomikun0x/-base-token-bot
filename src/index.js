import dotenv from 'dotenv';
dotenv.config();

import { startMonitor } from './monitor.js';

console.log('🚀 Base Token Alert Bot starting...');
startMonitor(); 
