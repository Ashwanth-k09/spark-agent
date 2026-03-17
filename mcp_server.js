#!/usr/bin/env node
'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const { Server }   = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const { analyzeError } = require('./src/utils/ai-analyzer');
const { checkAndInstallPrereqs } = require('./src/steps/check-prerequisites');
const { installSpark }           = require('./src/steps/install-spark');
const { configureCluster }       = require('./src/steps/configure-cluster');
const { startCluster, verifyCluster } = require('./src/steps/start-verify');
const { testConnection }         = require('./src/utils/ssh-executor');

// ── Create MCP Server ─────────────────────────────────────────
const server = new Server(
  { name: 'spark-ai-agent', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// ── List Tools ────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [

    {
      name: 'analyze_spark_error',
      description: 'Use Groq AI (Llama 3.3 70B) to analyze any Apache Spark or Linux error and get root cause, fix steps, and bash fix command',
      inputSchema: {
        type: 'object',
        properties: {
          error_text: {
            type: 'string',
            description: 'The full error message or log output to analyze'
          },
          context: {
            type: 'string',
            description: 'Optional context about where the error occurred (e.g. "during spark start")'
          }
        },
        required: ['error_text']
      }
    },

    {
      name: 'setup_spark_cluster',
      description: 'Fully automated Apache Spark cluster setup: installs prerequisites, installs Spark, configures master/workers, starts and verifies the cluster via SSH',
      inputSchema: {
        type: 'object',
        properties: {
          masterIp:    { type: 'string', description: 'IP address of the master node' },
          masterUser:  { type: 'string', description: 'SSH username for master node' },
          sshKeyPath:  { type: 'string', description: 'Absolute path to SSH private key, e.g. /home/vboxuser/.ssh/id_rsa' },
          sparkPort:   { type: 'number', description: 'Spark master port, default 7077' },
          workers: {
            type: 'array',
            description: 'List of worker nodes',
            items: {
              type: 'object',
              properties: {
                ip:       { type: 'string' },
                username: { type: 'string' }
              },
              required: ['ip', 'username']
            }
          }
        },
        required: ['masterIp', 'masterUser', 'sshKeyPath', 'workers']
      }
    },

    {
      name: 'test_ssh_connection',
      description: 'Test SSH connectivity to a node in your Spark cluster',
      inputSchema: {
        type: 'object',
        properties: {
          ip:       { type: 'string', description: 'IP address of the node' },
          username: { type: 'string', description: 'SSH username' },
          keyPath:  { type: 'string', description: 'Path to SSH private key' }
        },
        required: ['ip', 'username', 'keyPath']
      }
    }

  ]
}));

// ── Handle Tool Calls ─────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── Tool 1: Analyze Error ───────────────────────────────────
  if (name === 'analyze_spark_error') {
    try {
      const { ruleMatch, aiAnalysis } = await analyzeError(
        args.error_text,
        args.context || ''
      );

      const output = [
        '🤖 SPARK AI ERROR ANALYSIS',
        '══════════════════════════',
        `Severity        : ${aiAnalysis.severity}`,
        `Root Cause      : ${aiAnalysis.root_cause}`,
        '',
        '📋 Solution Steps:',
        ...(aiAnalysis.solution_steps || []).map((s, i) => `  ${i + 1}. ${s}`),
        '',
        `🔧 Fix Command   : ${aiAnalysis.fix_command}`,
        `🛡  Prevention   : ${aiAnalysis.prevention}`,
        `⏱  Est. Fix Time : ${aiAnalysis.estimated_fix_time}`,
        ruleMatch ? `\n📌 Rule Engine Match: [${ruleMatch.id}] ${ruleMatch.fix}` : ''
      ].join('\n');

      return { content: [{ type: 'text', text: output }] };

    } catch (err) {
      return { content: [{ type: 'text', text: `Error calling Groq AI: ${err.message}` }] };
    }
  }

  // ── Tool 2: Full Cluster Setup ──────────────────────────────
  if (name === 'setup_spark_cluster') {
    try {
      const config = {
        masterIp:   args.masterIp,
        masterUser: args.masterUser,
        username:   args.masterUser,
        sshKeyPath: args.sshKeyPath,
        sparkPort:  args.sparkPort || 7077,
        sshMode:    'existing',
        workers:    args.workers
      };

      const logs = [];
      const log  = (msg) => logs.push(msg);

      log('🚀 Starting Spark cluster setup...');
      log(`   Master : ${config.masterUser}@${config.masterIp}:${config.sparkPort}`);
      config.workers.forEach((w, i) => log(`   Worker ${i+1}: ${w.username}@${w.ip}`));

      log('\n[Step 1/4] Checking prerequisites...');
      await checkAndInstallPrereqs(config);
      log('✅ Prerequisites OK');

      log('\n[Step 2/4] Installing Spark on all nodes...');
      await installSpark(config);
      log('✅ Spark installed');

      log('\n[Step 3/4] Configuring cluster...');
      await configureCluster(config);
      log('✅ Cluster configured');

      log('\n[Step 4/4] Starting and verifying cluster...');
      await startCluster(config);
      await verifyCluster(config);
      log('✅ Cluster started and verified');

      log('\n🎉 SPARK CLUSTER IS READY!');
      log(`   Dashboard: http://${config.masterIp}:8080`);

      return { content: [{ type: 'text', text: logs.join('\n') }] };

    } catch (err) {
      return { content: [{ type: 'text', text: `❌ Setup failed: ${err.message}` }] };
    }
  }

  // ── Tool 3: Test SSH Connection ─────────────────────────────
  if (name === 'test_ssh_connection') {
    try {
      const result = await testConnection(args.ip, args.username, args.keyPath);
      const ok = result.stdout.includes('CONN_OK');
      return {
        content: [{
          type: 'text',
          text: ok
            ? `✅ SSH connection successful → ${args.username}@${args.ip}`
            : `❌ SSH connection failed → ${args.username}@${args.ip}\nError: ${result.stderr}`
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ SSH test error: ${err.message}` }] };
    }
  }

  return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
});

// ── Start Server ──────────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('✅ Spark AI Agent MCP server running');
}

main().catch(console.error);
