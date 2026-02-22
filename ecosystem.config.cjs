module.exports = {
  apps: [{
    name: "kiro-slack-bot",
    script: "dist/index.js",
    exp_backoff_restart_delay: 100,
    max_memory_restart: "512M",
    min_uptime: "5s",
    env: {
      NODE_ENV: "production"
    }
  }]
};
