/**
 * Isolated Benchmark: Measures real benefit of Engram integration
 *
 * Creates a clean test project, indexes it, then measures:
 * 1. Baseline: codegraph_explore without Engram
 * 2. With Memory: codegraph_explore_with_memory with Engram
 * 3. Compares latency, output size, and result quality
 *
 * Run: node scripts/benchmark-isolated.mjs
 */

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CodeGraph } from '../dist/index.js';
import { ToolHandler } from '../dist/mcp/tools.js';
import { spawn } from 'node:child_process';

const TEST_PROJECT_DIR = join(process.cwd(), 'benchmark-test-project');
const ENGRAM_STUB_SCRIPT = join(process.cwd(), 'scripts', 'engram-stub.mjs');

// Test queries representing typical agent explore patterns
const TEST_QUERIES = [
  { name: 'single-symbol', query: 'AuthService', description: 'Single symbol lookup' },
  { name: 'flow-explore', query: 'UserController handleLogin', description: 'Flow exploration' },
  { name: 'multi-symbol', query: 'AuthService UserService UserController', description: 'Multi-symbol query' },
  { name: 'callers', query: 'login', description: 'Find callers of login' },
  { name: 'impact', query: 'AuthService', description: 'Impact analysis' },
];

const REPS = 5;

function createTestProject() {
  console.log('[benchmark] Creating test project...');
  
  if (existsSync(TEST_PROJECT_DIR)) {
    rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
  }
  
  mkdirSync(TEST_PROJECT_DIR, { recursive: true });
  const srcDir = join(TEST_PROJECT_DIR, 'src');
  mkdirSync(srcDir, { recursive: true });

  // Create a realistic TypeScript project with multiple files and relationships
  const files = {
    'models/user.ts': `
export interface User {
  id: string;
  name: string;
  email: string;
  createdAt: Date;
}

export interface UserRole {
  userId: string;
  role: 'admin' | 'user' | 'moderator';
}

export class UserModel {
  private users: Map<string, User> = new Map();
  
  createUser(name: string, email: string): User {
    const user: User = {
      id: Math.random().toString(36).substr(2, 9),
      name,
      email,
      createdAt: new Date(),
    };
    this.users.set(user.id, user);
    return user;
  }
  
  getUser(id: string): User | undefined {
    return this.users.get(id);
  }
  
  getAllUsers(): User[] {
    return Array.from(this.users.values());
  }
  
  deleteUser(id: string): boolean {
    return this.users.delete(id);
  }
}
`,
    'services/auth.ts': `
import { UserModel } from '../models/user';

export class AuthService {
  private userModel: UserModel;
  private sessions: Map<string, string> = new Map();
  
  constructor(userModel: UserModel) {
    this.userModel = userModel;
  }
  
  login(email: string, password: string): string | null {
    const user = this.userModel.getAllUsers().find(u => u.email === email);
    if (user) {
      const sessionId = Math.random().toString(36).substr(2, 9);
      this.sessions.set(sessionId, user.id);
      return sessionId;
    }
    return null;
  }
  
  logout(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }
  
  validateSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
  
  getUserIdFromSession(sessionId: string): string | null {
    return this.sessions.get(sessionId) || null;
  }
}
`,
    'services/user.ts': `
import { UserModel, User } from '../models/user';
import { AuthService } from './auth';

export class UserService {
  private userModel: UserModel;
  private authService: AuthService;
  
  constructor(userModel: UserModel, authService: AuthService) {
    this.userModel = userModel;
    this.authService = authService;
  }
  
  createUser(name: string, email: string, password: string): User {
    const user = this.userModel.createUser(name, email);
    this.authService.login(email, password);
    return user;
  }
  
  getUser(id: string): User | undefined {
    return this.userModel.getUser(id);
  }
  
  getAllUsers(): User[] {
    return this.userModel.getAllUsers();
  }
  
  deleteUser(id: string, sessionId: string): boolean {
    if (this.authService.validateSession(sessionId)) {
      this.authService.logout(sessionId);
      return this.userModel.deleteUser(id);
    }
    return false;
  }
  
  updateUser(id: string, updates: Partial<User>): User | undefined {
    const user = this.userModel.getUser(id);
    if (user) {
      Object.assign(user, updates);
      return user;
    }
    return undefined;
  }
}
`,
    'controllers/auth.ts': `
import { AuthService } from '../services/auth';
import { UserService } from '../services/user';

export class AuthController {
  private authService: AuthService;
  private userService: UserService;
  
  constructor(authService: AuthService, userService: UserService) {
    this.authService = authService;
    this.userService = userService;
  }
  
  handleLogin(email: string, password: string): { success: boolean; sessionId?: string } {
    const sessionId = this.authService.login(email, password);
    return { success: !!sessionId, sessionId };
  }
  
  handleLogout(sessionId: string): { success: boolean } {
    const success = this.authService.logout(sessionId);
    return { success };
  }
  
  handleValidateSession(sessionId: string): { valid: boolean } {
    const valid = this.authService.validateSession(sessionId);
    return { valid };
  }
}
`,
    'controllers/user.ts': `
import { UserService } from '../services/user';
import { AuthService } from '../services/auth';

export class UserController {
  private userService: UserService;
  private authService: AuthService;
  
  constructor(userService: UserService, authService: AuthService) {
    this.userService = userService;
    this.authService = authService;
  }
  
  handleGetUser(id: string, sessionId: string): { success: boolean; user?: any } {
    if (!this.authService.validateSession(sessionId)) {
      return { success: false };
    }
    const user = this.userService.getUser(id);
    return { success: !!user, user };
  }
  
  handleGetAllUsers(sessionId: string): { success: boolean; users?: any[] } {
    if (!this.authService.validateSession(sessionId)) {
      return { success: false };
    }
    const users = this.userService.getAllUsers();
    return { success: true, users };
  }
  
  handleCreateUser(name: string, email: string, password: string): { success: boolean; user?: any } {
    const user = this.userService.createUser(name, email, password);
    return { success: true, user };
  }
  
  handleDeleteUser(id: string, sessionId: string): { success: boolean } {
    if (!this.authService.validateSession(sessionId)) {
      return { success: false };
    }
    const success = this.userService.deleteUser(id, sessionId);
    return { success };
  }
}
`,
    'utils/validation.ts': `
export class EmailValidator {
  static validate(email: string): boolean {
    const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
    return emailRegex.test(email);
  }
  
  static normalize(email: string): string {
    return email.toLowerCase().trim();
  }
}

export class PasswordValidator {
  static validate(password: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    
    if (password.length < 8) {
      errors.push('Password must be at least 8 characters');
    }
    if (!/[A-Z]/.test(password)) {
      errors.push('Password must contain uppercase letter');
    }
    if (!/[a-z]/.test(password)) {
      errors.push('Password must contain lowercase letter');
    }
    if (!/[0-9]/.test(password)) {
      errors.push('Password must contain number');
    }
    
    return { valid: errors.length === 0, errors };
  }
}
`,
    'utils/logger.ts': `
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error',
}

export class Logger {
  private static instance: Logger;
  private logLevel: LogLevel;
  
  private constructor(logLevel: LogLevel = LogLevel.INFO) {
    this.logLevel = logLevel;
  }
  
  static getInstance(logLevel?: LogLevel): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger(logLevel);
    }
    return Logger.instance;
  }
  
  debug(message: string, ...args: any[]): void {
    if (this.shouldLog(LogLevel.DEBUG)) {
      console.log('[DEBUG] ' + message, ...args);
    }
  }
  
  info(message: string, ...args: any[]): void {
    if (this.shouldLog(LogLevel.INFO)) {
      console.log('[INFO] ' + message, ...args);
    }
  }
  
  warn(message: string, ...args: any[]): void {
    if (this.shouldLog(LogLevel.WARN)) {
      console.warn('[WARN] ' + message, ...args);
    }
  }
  
  error(message: string, ...args: any[]): void {
    if (this.shouldLog(LogLevel.ERROR)) {
      console.error('[ERROR] ' + message, ...args);
    }
  }
  
  private shouldLog(level: LogLevel): boolean {
    const levels = [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR];
    return levels.indexOf(level) >= levels.indexOf(this.logLevel);
  }
}
`,
    'index.ts': `
import { UserModel } from './models/user';
import { AuthService } from './services/auth';
import { UserService } from './services/user';
import { AuthController } from './controllers/auth';
import { UserController } from './controllers/user';
import { EmailValidator, PasswordValidator } from './utils/validation';
import { Logger } from './utils/logger';

const userModel = new UserModel();
const authService = new AuthService(userModel);
const userService = new UserService(userModel, authService);
const authController = new AuthController(authService, userService);
const userController = new UserController(userService, authService);
const logger = Logger.getInstance();

export {
  userModel,
  authService,
  userService,
  authController,
  userController,
  EmailValidator,
  PasswordValidator,
  logger,
};
`,
  };

  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(srcDir, filePath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content);
  }

  console.log('[benchmark] Test project created at: ' + TEST_PROJECT_DIR);
  console.log('[benchmark] Files: ' + Object.keys(files).length);
}

function startEngramStub() {
  return new Promise((resolve, reject) => {
    const port = 4500 + Math.floor(Math.random() * 100);
    const url = 'http://localhost:' + port;

    const stub = spawn('node', [ENGRAM_STUB_SCRIPT], {
      env: { ...process.env, ENGRAM_STUB_PORT: String(port) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const timeout = setTimeout(() => {
      reject(new Error('Engram stub failed to start within 5s'));
    }, 5000);

    stub.stdout?.on('data', (data) => {
      if (data.toString().includes('Listening')) {
        clearTimeout(timeout);
        resolve({
          url: url,
          stop: () => stub.kill('SIGTERM'),
        });
      }
    });

    stub.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function textOf(result) {
  const first = result?.content?.[0];
  return (first && first.text) || '';
}

async function main() {
  console.log('=== Isolated Benchmark: Engram Integration Benefit ===\n');

  // Step 1: Create and index test project
  createTestProject();

  console.log('[benchmark] Indexing project...');
  const cg = await CodeGraph.init(TEST_PROJECT_DIR, { index: true });
  console.log('[benchmark] Project indexed successfully\n');

  // Step 2: Start Engram stub
  console.log('[benchmark] Starting Engram stub...');
  const engram = await startEngramStub();
  console.log('[benchmark] Engram stub running at: ' + engram.url + '\n');

  // Step 3: Seed Engram with insights
  console.log('[benchmark] Seeding Engram with project insights...');
  const handler = new ToolHandler(cg);
  
  // First, sync insights to Engram
  process.env.CODEGRAPH_ENGRAM_ENABLED = '1';
  process.env.ENGRAM_URL = engram.url;
  await cg.syncInsightsToEngram();
  console.log('[benchmark] Engram seeded with insights\n');

  // Step 4: Warmup
  console.log('[benchmark] Warming up...');
  for (const { query } of TEST_QUERIES.slice(0, 2)) {
    await handler.execute('codegraph_explore', { query, projectPath: TEST_PROJECT_DIR });
    await handler.execute('codegraph_explore_with_memory', { query, projectPath: TEST_PROJECT_DIR });
  }
  console.log('[benchmark] Warmup complete\n');

  // Step 5: Measure baseline (without memory)
  console.log('[benchmark] Measuring BASELINE (without Engram memory)...\n');
  const baselineResults = [];
  
  for (const { name, query, description } of TEST_QUERIES) {
    console.log('  Query: ' + name + ' - "' + query + '"');
    const measurements = [];
    
    for (let i = 0; i < REPS; i++) {
      const start = Date.now();
      const result = await handler.execute('codegraph_explore', { query, projectPath: TEST_PROJECT_DIR });
      const elapsed = Date.now() - start;
      const text = textOf(result);
      
      measurements.push({
        elapsed_ms: elapsed,
        chars: text.length,
        has_result: text.length > 0,
      });
    }
    
    const med = {
      name: name,
      description: description,
      query: query,
      median_ms: median(measurements.map(m => m.elapsed_ms)),
      median_chars: median(measurements.map(m => m.chars)),
      all_runs: measurements,
    };
    
    baselineResults.push(med);
    console.log('    Median: ' + med.median_ms + 'ms, ' + med.median_chars + ' chars\n');
  }

  // Step 6: Measure with memory
  console.log('[benchmark] Measuring WITH ENGRAM MEMORY...\n');
  const memoryResults = [];
  
  for (const { name, query, description } of TEST_QUERIES) {
    console.log('  Query: ' + name + ' - "' + query + '"');
    const measurements = [];
    
    for (let i = 0; i < REPS; i++) {
      const start = Date.now();
      const result = await handler.execute('codegraph_explore_with_memory', { query, projectPath: TEST_PROJECT_DIR });
      const elapsed = Date.now() - start;
      const text = textOf(result);
      
      measurements.push({
        elapsed_ms: elapsed,
        chars: text.length,
        has_memory: text.includes('Project Memory'),
        has_result: text.length > 0,
      });
    }
    
    const med = {
      name: name,
      description: description,
      query: query,
      median_ms: median(measurements.map(m => m.elapsed_ms)),
      median_chars: median(measurements.map(m => m.chars)),
      has_memory: measurements.some(m => m.has_memory),
      all_runs: measurements,
    };
    
    memoryResults.push(med);
    console.log('    Median: ' + med.median_ms + 'ms, ' + med.median_chars + ' chars, hasMemory: ' + med.has_memory + '\n');
  }

  // Step 7: Calculate comparison
  console.log('=== RESULTS ===\n');
  
  const comparison = baselineResults.map((baseline, i) => {
    const memory = memoryResults[i];
    return {
      name: baseline.name,
      description: baseline.description,
      query: baseline.query,
      baseline_ms: baseline.median_ms,
      memory_ms: memory.median_ms,
      overhead_ms: memory.median_ms - baseline.median_ms,
      overhead_pct: ((memory.median_ms - baseline.median_ms) / baseline.median_ms * 100).toFixed(1),
      baseline_chars: baseline.median_chars,
      memory_chars: memory.median_chars,
      chars_diff: memory.median_chars - baseline.median_chars,
      has_memory: memory.has_memory,
    };
  });

  console.log('Query                    | Baseline | With Memory | Overhead | Chars Diff | Has Memory');
  console.log('-------------------------|----------|--------------|----------|------------|------------');
  for (const c of comparison) {
    console.log(
      c.name.padEnd(24) + ' | ' + String(c.baseline_ms).padStart(6) + 'ms | ' + String(c.memory_ms).padStart(10) + 'ms | ' + String(c.overhead_ms).padStart(6) + 'ms (' + c.overhead_pct + '%) | ' + String(c.chars_diff).padStart(8) + ' | ' + c.has_memory
    );
  }

  const avgBaseline = Math.round(baselineResults.reduce((s, r) => s + r.median_ms, 0) / baselineResults.length);
  const avgMemory = Math.round(memoryResults.reduce((s, r) => s + r.median_ms, 0) / memoryResults.length);
  const avgOverhead = Math.round((avgMemory - avgBaseline) / avgBaseline * 100);
  const avgCharsDiff = Math.round(memoryResults.reduce((s, r) => s + r.median_chars, 0) / memoryResults.length - 
                       baselineResults.reduce((s, r) => s + r.median_chars, 0) / baselineResults.length);

  console.log('\n=== SUMMARY ===');
  console.log('Average baseline latency: ' + avgBaseline + 'ms');
  console.log('Average with memory latency: ' + avgMemory + 'ms');
  console.log('Average overhead: ' + avgOverhead + '%');
  console.log('Average chars difference: ' + (avgCharsDiff > 0 ? '+' : '') + avgCharsDiff);
  console.log('Queries with memory enrichment: ' + memoryResults.filter(r => r.has_memory).length + '/' + memoryResults.length);

  // Step 8: Cleanup
  console.log('\n[benchmark] Cleaning up...');
  await cg.close();
  engram.stop();
  rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
  console.log('[benchmark] Cleanup complete');

  // Step 9: Save results
  const output = {
    timestamp: new Date().toISOString(),
    node_version: process.version,
    platform: process.platform,
    test_project: {
      files: 8,
      symbols: 'multiple classes, interfaces, functions',
    },
    queries_tested: TEST_QUERIES.length,
    reps_per_query: REPS,
    comparison: comparison,
    summary: {
      avg_baseline_ms: avgBaseline,
      avg_memory_ms: avgMemory,
      avg_overhead_pct: avgOverhead,
      avg_chars_diff: avgCharsDiff,
      queries_with_memory: memoryResults.filter(r => r.has_memory).length,
      total_queries: memoryResults.length,
    },
  };

  const outputPath = join(process.cwd(), 'benchmark-isolated-results.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log('\n[benchmark] Results saved to: ' + outputPath);
}

main().catch((err) => {
  console.error('[benchmark] FAILED:', err);
  process.exit(1);
});
