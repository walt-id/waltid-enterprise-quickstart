#!/usr/bin/env node
/**
 * walt.ts - walt.id Enterprise Stack CLI Tool
 * 
 * This is a thin wrapper that imports and runs the modular CLI from src/.
 * 
 * For the actual implementation, see:
 * - src/index.ts - Main entry point and CLI parsing
 * - src/config.ts - Configuration and constants
 * - src/context.ts - Command context and utilities
 * - src/commands/ - Individual commands
 * - src/flows/ - Multi-step flows
 * 
 * Usage:
 *   npx tsx walt.ts                    # Full setup + primary use case
 *   npx tsx walt.ts --recreate         # Recreate DB and setup from scratch
 *   npx tsx walt.ts --setup-all        # Run all setup commands
 *   npx tsx walt.ts --run-all          # Run primary use case (issue + verify)
 *   npx tsx walt.ts --help             # Show all available commands
 */

// Re-export everything from the modular implementation
import './src/index.js';
