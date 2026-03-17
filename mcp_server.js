#!/usr/bin/env node
'use strict';

const { McpServer }            = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z }                    = require('zod');
const { execSync }             = require('child_process');
const fs                       = require('fs');
const os                       = require('os');
const path                     = require('path');

const SPARK_HOME = process.env.SPARK_HOME || '/opt/spark';
const STORE_PATH = path.join(os.homedir(), '.spark-agent-connections.json');

function runCmd(cmd, timeout = 30000) {
  try {
    const out = execSync(cmd, { timeout, encoding: 'utf8', shell: '/bin/bash' });
    return { success: true, output: out.trim() };
  } catch (err) {
    return { success: false, output: err.stderr || err.message };
  }
}

function loadConnections() {
  try {
    if (!fs.existsSync(STORE_PATH)) return [];
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (_) { return []; }
}

const server = new McpServer({ name: 'spark-agent', version: '1.0.0' });

// ── Tool 1: Cluster status ────────────────────────────────────
server.tool('get_cluster_status',
  'Get current Spark cluster status — shows master and workers running or down',
  {},
  async () => {
    const master      = runCmd("pgrep -af 'spark.deploy.master' | grep -v grep");
    const worker      = runCmd("pgrep -af 'spark.deploy.worker' | grep -v grep");
    const connections = loadConnections();
    let out = '=== SPARK CLUSTER STATUS ===\n\n';
    if (connections.length > 0) {
      const c = connections[0];
      out += `Master    : ${c.masterIp}:${c.sparkPort}\n`;
      out += `Master UI : http://${c.masterIp}:${c.webUiPort}\n`;
      c.workers.forEach((w, i) => {
        const ip = typeof w === 'string' ? w : w.ip;
        out += `Worker ${i+1}  : ${ip}:${8081+i}\n`;
      });
      out += '\n';
    }
    out += `Master Process : ${master.output ? '● RUNNING' : '✗ DOWN'}\n`;
    out += `Worker Process : ${worker.output ? '● RUNNING' : '✗ DOWN'}\n`;
    const ports = runCmd('sudo netstat -tlnp 2>/dev/null | grep java');
    if (ports.output) out += `\nListening:\n${ports.output}\n`;
    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Tool 2: Start cluster ─────────────────────────────────────
server.tool('start_spark_cluster',
  'Start the Spark master and all worker nodes using saved connection config',
  {},
  async () => {
    const connections = loadConnections();
    if (!connections.length) return { content: [{ type: 'text', text: 'No saved connections. Run the agent first.' }] };
    const c          = connections[0];
    const masterIp   = c.masterIp;
    const sparkPort  = c.sparkPort  || '7077';
    const webUiPort  = c.webUiPort  || '8080';
    let out = '=== STARTING SPARK CLUSTER ===\n\n';

    // Write spark-env.sh
    runCmd(`
mkdir -p ${SPARK_HOME}/conf ${SPARK_HOME}/logs
cat > ${SPARK_HOME}/conf/spark-env.sh << 'ENVEOF'
export SPARK_MASTER_HOST=${masterIp}
export SPARK_LOCAL_IP=${masterIp}
export SPARK_MASTER_PORT=${sparkPort}
export SPARK_MASTER_WEBUI_PORT=${webUiPort}
export JAVA_HOME=$(readlink -f /usr/bin/java | sed 's:/bin/java::')
export SPARK_HOME=${SPARK_HOME}
ENVEOF
`);

    // Stop any existing
    runCmd('pkill -9 -f "deploy.master" 2>/dev/null; pkill -9 -f "deploy.worker" 2>/dev/null; sleep 2');

    // Start master
    const m = runCmd(`
unset SPARK_LOCAL_IP
SPARK_LOCAL_IP=${masterIp} SPARK_MASTER_HOST=${masterIp} \
nohup ${SPARK_HOME}/bin/spark-class org.apache.spark.deploy.master.Master \
  --host ${masterIp} --port ${sparkPort} --webui-port ${webUiPort} \
  > ${SPARK_HOME}/logs/master.out 2>&1 &
sleep 4 && echo MASTER_STARTED
`, 20000);
    out += m.output.includes('MASTER_STARTED') ? `✓ Master started → spark://${masterIp}:${sparkPort}\n` : `✗ Master failed\n`;

    // Start workers
    for (let i = 0; i < c.workers.length; i++) {
      const w        = c.workers[i];
      const workerIp = typeof w === 'string' ? w : w.ip;
      const wport    = 8081 + i;
      const wr = runCmd(`
unset SPARK_LOCAL_IP
SPARK_LOCAL_IP=${workerIp} SPARK_WORKER_WEBUI_PORT=${wport} \
nohup ${SPARK_HOME}/bin/spark-class org.apache.spark.deploy.worker.Worker \
  --host ${workerIp} --webui-port ${wport} \
  spark://${masterIp}:${sparkPort} \
  > ${SPARK_HOME}/logs/worker-${i+1}.out 2>&1 &
sleep 4 && echo WORKER_STARTED
`, 20000);
      out += wr.output.includes('WORKER_STARTED') ? `✓ Worker ${i+1} started → ${workerIp}:${wport}\n` : `✗ Worker ${i+1} failed\n`;
    }
    out += `\nOpen Master UI: http://${masterIp}:${webUiPort}`;
    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Tool 3: Stop cluster ──────────────────────────────────────
server.tool('stop_spark_cluster',
  'Stop all running Spark master and worker processes',
  {},
  async () => {
    runCmd('pkill -9 -f "deploy.master" 2>/dev/null; pkill -9 -f "deploy.worker" 2>/dev/null');
    await new Promise(r => setTimeout(r, 2000));
    const check = runCmd("pgrep -af 'spark.deploy' | grep -v grep");
    return { content: [{ type: 'text', text: !check.output ? '✓ All Spark processes stopped' : `⚠ Still running:\n${check.output}` }] };
  }
);

// ── Tool 4: Run SparkPi test ──────────────────────────────────
server.tool('run_spark_pi',
  'Run the SparkPi test job to verify the cluster works correctly',
  { partitions: z.number().optional().describe('Number of partitions, default 10') },
  async ({ partitions = 10 }) => {
    const connections = loadConnections();
    if (!connections.length) return { content: [{ type: 'text', text: 'No saved connections.' }] };
    const masterIp  = connections[0].masterIp;
    const sparkPort = connections[0].sparkPort || '7077';
    const res = runCmd(
      `export SPARK_HOME=${SPARK_HOME} && ${SPARK_HOME}/bin/spark-submit ` +
      `--master spark://${masterIp}:${sparkPort} ` +
      `--class org.apache.spark.examples.SparkPi ` +
      `${SPARK_HOME}/examples/jars/spark-examples_2.12-3.5.0.jar ${partitions} 2>&1 | grep -E "Pi is|ERROR|WARN" | tail -5`,
      120000
    );
    return { content: [{ type: 'text', text: res.output || 'Job completed' }] };
  }
);

// ── Tool 5: View saved connections ───────────────────────────
server.tool('get_saved_connections',
  'Show all saved Spark cluster connections',
  {},
  async () => {
    const connections = loadConnections();
    if (!connections.length) return { content: [{ type: 'text', text: 'No saved connections found.' }] };
    let out = `Found ${connections.length} connection(s):\n\n`;
    connections.forEach((c, i) => {
      out += `[${i+1}] Master : ${c.masterUser}@${c.masterIp}:${c.sparkPort}\n`;
      out += `     Key    : ${c.sshKeyPath}\n`;
      out += `     Saved  : ${c.savedAt || 'unknown'}\n\n`;
    });
    return { content: [{ type: 'text', text: out }] };
  }
);

// ── Tool 6: View Spark logs ───────────────────────────────────
server.tool('get_spark_logs',
  'Get the last N lines from Spark master or worker logs',
  {
    node:  z.enum(['master', 'worker1', 'worker2']).describe('Which node logs to view'),
    lines: z.number().optional().describe('Number of lines to show, default 20'),
  },
  async ({ node, lines = 20 }) => {
    const logMap = {
      master:  `${SPARK_HOME}/logs/master.out`,
      worker1: `${SPARK_HOME}/logs/worker-1.out`,
      worker2: `${SPARK_HOME}/logs/worker-2.out`,
    };
    const logFile = logMap[node];
    if (!fs.existsSync(logFile)) return { content: [{ type: 'text', text: `Log file not found: ${logFile}` }] };
    const res = runCmd(`tail -${lines} ${logFile}`);
    return { content: [{ type: 'text', text: `=== ${node.toUpperCase()} LOG (last ${lines} lines) ===\n\n${res.output}` }] };
  }
);

// ── Tool 7: Install Spark ─────────────────────────────────────
server.tool('install_spark',
  'Download and install Apache Spark 3.5.0 on this machine if not already installed',
  {},
  async () => {
    if (fs.existsSync(`${SPARK_HOME}/bin/spark-submit`)) {
      return { content: [{ type: 'text', text: '✓ Spark is already installed at /opt/spark' }] };
    }
    const res = runCmd(`
cd /tmp
wget -q https://archive.apache.org/dist/spark/spark-3.5.0/spark-3.5.0-bin-hadoop3.tgz -O spark.tgz
tar -xzf spark.tgz
sudo mv spark-3.5.0-bin-hadoop3 /opt/spark
sudo chown -R $USER:$USER /opt/spark
rm -f spark.tgz
echo INSTALLED_OK
`, 600000);
    return { content: [{ type: 'text', text: res.output.includes('INSTALLED_OK') ? '✓ Spark 3.5.0 installed at /opt/spark' : `✗ Install failed: ${res.output}` }] };
  }
);

// ── Start MCP server ──────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Spark Agent MCP server running');
}

main().catch(console.error);
