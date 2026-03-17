'use strict';
const chalk = require('chalk');
const ora   = require('ora');
const { runOnNode }    = require('../utils/ssh-executor');
const { analyzeError } = require('../utils/ai-analyzer');

function getNodeList(config) {
  const masterUser = config.masterUser || config.username;
  const nodes = [];
  config.workers.forEach((w, i) => {
    const ip       = typeof w === 'string' ? w : w.ip;
    const username = typeof w === 'string' ? masterUser : (w.username || masterUser);
    nodes.push({ label: `Worker ${i + 1}`, ip, username });
  });
  return nodes;
}

async function configureMaster(config) {
  const masterUser = config.masterUser || config.username;
  const spin = ora(`  Configuring Master (${masterUser}@${config.masterIp})...`).start();

  const workerIps = config.workers.map(w =>
    typeof w === 'string' ? w : w.ip
  );
  const workerLines = workerIps.map(ip => `echo '${ip}' >> $SPARK_HOME/conf/workers`).join('\n');

  const script = `
set -e
export SPARK_HOME=/opt/spark
if [ ! -d "$SPARK_HOME" ]; then echo "SPARK_NOT_FOUND"; exit 1; fi
[ -f $SPARK_HOME/conf/spark-env.sh.template ] \
  && cp $SPARK_HOME/conf/spark-env.sh.template $SPARK_HOME/conf/spark-env.sh \
  || touch $SPARK_HOME/conf/spark-env.sh
echo 'export SPARK_MASTER_HOST=${config.masterIp}'        >> $SPARK_HOME/conf/spark-env.sh
echo 'export SPARK_MASTER_PORT=${config.sparkPort}'       >> $SPARK_HOME/conf/spark-env.sh
echo 'export SPARK_MASTER_WEBUI_PORT=${config.webUiPort}' >> $SPARK_HOME/conf/spark-env.sh
echo 'export SPARK_EXECUTOR_MEMORY=2g'                    >> $SPARK_HOME/conf/spark-env.sh
echo 'export SPARK_DRIVER_MEMORY=1g'                      >> $SPARK_HOME/conf/spark-env.sh
JHOME=$(readlink -f /usr/bin/java | sed 's:/bin/java::')
echo "export JAVA_HOME=\$JHOME"                           >> $SPARK_HOME/conf/spark-env.sh
echo 'export SPARK_SSH_OPTS="-o StrictHostKeyChecking=no"' >> $SPARK_HOME/conf/spark-env.sh
[ -f $SPARK_HOME/conf/workers.template ] \
  && cp $SPARK_HOME/conf/workers.template $SPARK_HOME/conf/workers \
  || echo '' > $SPARK_HOME/conf/workers
sed -i '/localhost/d' $SPARK_HOME/conf/workers
${workerLines}
echo "MASTER_OK"
`;

  const res = await runOnNode(config.masterIp, masterUser, script, config.sshKeyPath);

  if (res.stdout.includes('SPARK_NOT_FOUND')) {
    spin.fail(chalk.red('  ✗ Spark not found at /opt/spark — Spark install failed'));
  } else if (res.stdout.includes('MASTER_OK')) {
    spin.succeed(chalk.green(`  ✓ Master configured — workers: ${workerIps.join(', ')}`));
  } else {
    spin.fail(chalk.red('  ✗ Master config failed'));
    console.log(chalk.red('  stdout: ' + res.stdout));
    console.log(chalk.red('  stderr: ' + res.stderr));
    const { ruleMatch, aiAnalysis } = await analyzeError(res.stderr || res.stdout, 'Configuring Spark master');
    if (ruleMatch) await runOnNode(config.masterIp, masterUser, ruleMatch.fix, config.sshKeyPath);
    console.log(chalk.blue(`  Root cause: ${aiAnalysis.root_cause}`));
    aiAnalysis.solution_steps?.forEach((s, i) => console.log(chalk.blue(`  ${i + 1}. ${s}`)));
  }
}

async function configureWorker(node, config) {
  const spin = ora(`  Configuring ${node.label} (${node.username}@${node.ip})...`).start();

  const script = `
set -e
export SPARK_HOME=/opt/spark
if [ ! -d "$SPARK_HOME" ]; then echo "SPARK_NOT_FOUND"; exit 1; fi
[ -f $SPARK_HOME/conf/spark-env.sh.template ] \
  && cp $SPARK_HOME/conf/spark-env.sh.template $SPARK_HOME/conf/spark-env.sh \
  || touch $SPARK_HOME/conf/spark-env.sh
echo 'export SPARK_MASTER_HOST=${config.masterIp}'  >> $SPARK_HOME/conf/spark-env.sh
echo 'export SPARK_LOCAL_IP=${node.ip}'             >> $SPARK_HOME/conf/spark-env.sh
echo 'export SPARK_WORKER_MEMORY=2g'                >> $SPARK_HOME/conf/spark-env.sh
echo 'export SPARK_WORKER_CORES=2'                  >> $SPARK_HOME/conf/spark-env.sh
JHOME=$(readlink -f /usr/bin/java | sed 's:/bin/java::')
echo "export JAVA_HOME=\$JHOME"                     >> $SPARK_HOME/conf/spark-env.sh
echo 'export SPARK_SSH_OPTS="-o StrictHostKeyChecking=no"' >> $SPARK_HOME/conf/spark-env.sh
echo "WORKER_OK"
`;

  const res = await runOnNode(node.ip, node.username, script, config.sshKeyPath);

  if (res.stdout.includes('SPARK_NOT_FOUND')) {
    spin.fail(chalk.red(`  ✗ Spark not found on ${node.label}`));
  } else if (res.stdout.includes('WORKER_OK')) {
    spin.succeed(chalk.green(`  ✓ ${node.label} configured`));
  } else {
    spin.fail(chalk.red(`  ✗ ${node.label} config failed`));
    console.log(chalk.red('  stdout: ' + res.stdout));
    console.log(chalk.red('  stderr: ' + res.stderr));
    const { ruleMatch, aiAnalysis } = await analyzeError(res.stderr || res.stdout, `Configuring ${node.label}`);
    if (ruleMatch) await runOnNode(node.ip, node.username, ruleMatch.fix, config.sshKeyPath);
    console.log(chalk.blue(`  Root cause: ${aiAnalysis.root_cause}`));
    aiAnalysis.solution_steps?.forEach((s, i) => console.log(chalk.blue(`  ${i + 1}. ${s}`)));
  }
}

async function configureCluster(config) {
  await configureMaster(config);
  const workers = getNodeList(config);
  for (const node of workers) {
    await configureWorker(node, config);
  }
}

module.exports = { configureCluster };
