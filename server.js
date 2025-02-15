// console.log('Starting server initialization...');

const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const helmet = require('helmet');
const config = require('./config');
const os = require('os');
const fs = require('fs');
const WebSocket = require('ws');

// 获取本机IP地址
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // 跳过内部地址和非IPv4地址
            if (!iface.internal && iface.family === 'IPv4') {
                return iface.address;
            }
        }
    }
    return 'localhost'; // 如果没找到，返回 localhost
}

const app = express();

// 添加安全相关中间件，但禁用部分限制
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

// 支持 JSON 请求体
app.use(express.json());

// 添加通用响应头
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// 处理 OPTIONS 请求 不知道为什么现在没法使用了，双击
app.options('*', (req, res) => {
    res.sendStatus(200);
});

// 静态文件服务
app.use(express.static(__dirname));

// 添加主页路由
app.get('/', (req, res) => {
    res.redirect('/project-launcher.html');
});

// 添加请求日志
app.use((req, res, next) => {
    next();
});

// 获取项目列表
app.get('/api/projects', (req, res) => {
    const projects = Object.entries(config.projects).map(([id, project]) => ({
        id,
        ...project
    }));
    res.json(projects);
});

// 存储运行中的项目进程和地址
const runningProcesses = new Map();
const projectUrls = new Map();
const statusFilePath = path.join(process.cwd(), 'server_status.json');

// 从状态文件加载状态
function loadProjectStatus() {
    try {
        if (fs.existsSync(statusFilePath)) {
            const status = JSON.parse(fs.readFileSync(statusFilePath, 'utf8'));
            Object.entries(status).forEach(([project, data]) => {
                projectUrls.set(project, data.urls);
            });
        }
    } catch (error) {
        console.error('Failed to load project status:', error);
    }
}

// 保存状态到文件
function saveProjectStatus() {
    try {
        const status = {};
        projectUrls.forEach((urls, project) => {
            status[project] = {
                urls,
                running: runningProcesses.has(project)
            };
        });
        fs.writeFileSync(statusFilePath, JSON.stringify(status, null, 2));
    } catch (error) {
        console.error('Failed to save project status:', error);
    }
}

// 启动项目
function startProjectProcess(project, command, cwd) {
    const child = exec(command, {
        cwd,
        env: { ...process.env, FORCE_COLOR: true },
        windowsHide: true, // 在 Windows 上隐藏命令提示符窗口
        shell: true // 使用 shell 执行命令
    });
    
    runningProcesses.set(project, child);
    return child;
}

// 项目启动路由
app.post('/start/:project', (req, res) => {
    const { project } = req.params;
    
    if (!config.projects[project]) {
        return res.status(400).send('Invalid project name');
    }

    // 如果项目已经在运行，返回成功
    if (runningProcesses.has(project)) {
        const urls = projectUrls.get(project);
        return res.json({
            status: 'success',
            message: 'Project is already running',
            urls: urls
        });
    }

    const { path: projectPath, command, nodeVersion } = config.projects[project];
    
    // 修改启动命令的执行方式
    const child = exec(`node start-project.js ${project}`, {
        maxBuffer: 1024 * 1024,
        windowsHide: true, // 在 Windows 上隐藏命令提示符窗口
        shell: true // 使用 shell 执行命令
    });

    // 存储启动时间和进程组ID
    child.startTime = Date.now();
    child.processGroup = process.platform === 'win32' ? child.pid : -child.pid;
    
    runningProcesses.set(project, child);
    let output = '';
    let error = '';
    let urls = { local: null, network: null };
    const localIP = getLocalIP();

    child.stdout.on('data', (data) => {
        output += data;
        const dataStr = data.toString().trim();
        
        // 从输出中提取项目URL
        const localUrlMatch = dataStr.match(/Local:\s+(https?:\/\/\S+)/);
        const networkUrlMatch = dataStr.match(/Network:\s+(https?:\/\/\S+)/);
        const viteUrlMatch = dataStr.match(/(https?:\/\/localhost:(\d+))/);
        
        let urlsFound = false;
        
        if (localUrlMatch) {
            urls.local = localUrlMatch[1];
            urlsFound = true;
        }
        if (networkUrlMatch) {
            urls.network = networkUrlMatch[1];
            urlsFound = true;
        }
        if (viteUrlMatch && !urls.local) {
            const [, url, port] = viteUrlMatch;
            urls.local = url;
            urls.network = `http://${localIP}:${port}`;
            urlsFound = true;
        }

        // 如果找到了URL，立即存储并返回响应
        if (urlsFound) {
            projectUrls.set(project, urls);
            saveProjectStatus();  // 保存状态
            if (!res.headersSent) {
                res.json({
                    status: 'success',
                    message: 'Project started successfully',
                    urls: urls
                });
            }
        }
    });

    child.stderr.on('data', (data) => {
        error += data;
    });

    child.on('error', (error) => {
        runningProcesses.delete(project);
        projectUrls.delete(project);
        if (!res.headersSent) {
            res.status(500).send(error.message);
        }
    });

    child.on('exit', (code) => {
        runningProcesses.delete(project);
        projectUrls.delete(project);
        if (code !== 0 && !res.headersSent) {
            res.status(500).send(`Process exited with code ${code}\n${error}`);
        }
    });

    // 设置超时，如果 30 秒内没有收到成功启动的信号，则返回超时错误
    setTimeout(() => {
        if (!res.headersSent) {
            res.status(500).send('Project startup timed out');
        }
    }, 30000);
});

// 获取项目状态
app.get('/status/:project', (req, res) => {
    const { project } = req.params;
    const urls = projectUrls.get(project) || { local: null, network: null };
    res.json({
        running: runningProcesses.has(project),
        urls: urls
    });
});

// 停止项目
app.post('/stop/:project', (req, res) => {
    const { project } = req.params;
    
    if (!config.projects[project]) {
        return res.status(400).json({
            status: 'error',
            message: 'Invalid project name'
        });
    }

    const process = runningProcesses.get(project);
    if (!process) {
        return res.json({
            status: 'success',
            message: 'Project is not running'
        });
    }

    try {
        // 在 Windows 上，使用多种方式确保进程被终止
        if (process.platform === 'win32') {
            // 首先获取项目的 URL 来提取端口
            const urls = projectUrls.get(project);
            if (urls && urls.local) {
                const port = urls.local.match(/:(\d+)/)[1];

                // 1. 使用 tasklist 找到所有 node.exe 进程
                exec('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', (error, stdout) => {
                    if (!error) {
                        const lines = stdout.split('\n');
                        const nodePids = [];
                        
                        // 解析 tasklist 输出
                        lines.forEach(line => {
                            const match = line.match(/"([^"]+)"/g);
                            if (match && match.length >= 2) {
                                const pid = match[1].replace(/"/g, '');
                                nodePids.push(pid);
                            }
                        });

                        // 对每个 node 进程，检查其命令行
                        nodePids.forEach(pid => {
                            exec(`wmic process where "ProcessId=${pid}" get CommandLine /format:list`, (error, stdout) => {
                                if (!error && stdout.includes(project)) {
                                    // 如果命令行包含项目名，终止该进程
                                    exec(`taskkill /F /T /PID ${pid}`, (error) => {
                                        if (error) {
                                            console.error(`Failed to kill process ${pid}: ${error.message}`);
                                        }
                                    });
                                }
                            });
                        });
                    }
                });

                // 2. 终止占用端口的进程
                exec(`for /f "tokens=5" %a in ('netstat -aon ^| find ":${port}"') do taskkill /F /T /PID %a`, (error) => {
                    if (error) {
                        console.error(`Failed to kill process on port ${port}: ${error.message}`);
                    }
                });

                // 3. 使用 process tree 终止
                exec(`wmic process where "ParentProcessId=${process.pid}" get ProcessId /format:list`, (error, stdout) => {
                    if (!error) {
                        const childPids = stdout.match(/ProcessId=(\d+)/g);
                        if (childPids) {
                            childPids.forEach(pidMatch => {
                                const pid = pidMatch.replace('ProcessId=', '');
                                exec(`taskkill /F /T /PID ${pid}`, (error) => {
                                    if (error) {
                                        console.error(`Failed to kill child process ${pid}: ${error.message}`);
                                    }
                                });
                            });
                        }
                    }
                });
            }

            // 4. 终止主进程
            exec(`taskkill /F /T /PID ${process.pid}`, (error) => {
                if (error) {
                    console.error(`Failed to kill main process: ${error.message}`);
                }
            });

            // 清理状态
            runningProcesses.delete(project);
            projectUrls.delete(project);
            saveProjectStatus();

            // 延迟返回响应，确保进程有时间被终止
            setTimeout(() => {
                // 再次检查端口是否被释放
                const net = require('net');
                const testServer = net.createServer();
                const port = urls.local.match(/:(\d+)/)[1];

                testServer.once('error', () => {
                    // 端口仍然被占用，再次尝试终止进程
                    exec(`for /f "tokens=5" %a in ('netstat -aon ^| find ":${port}"') do taskkill /F /T /PID %a`);
                });

                testServer.once('listening', () => {
                    testServer.close();
                });

                testServer.listen(port);

                res.json({
                    status: 'success',
                    message: 'Project stopped successfully'
                });
            }, 3000); // 增加延迟时间到 3 秒
        } else {
            // 在 Unix 系统上使用进程组 ID 终止整个进程树
            try {
                process.kill(-process.processGroup, 'SIGKILL');
            } catch (error) {
                console.error(`Failed to kill process group: ${error.message}`);
            }
            
            runningProcesses.delete(project);
            projectUrls.delete(project);
            saveProjectStatus();
            
            setTimeout(() => {
                res.json({
                    status: 'success',
                    message: 'Project stopped successfully'
                });
            }, 3000);
        }
    } catch (error) {
        console.error(`Error stopping project: ${error.message}`);
        runningProcesses.delete(project);
        projectUrls.delete(project);
        saveProjectStatus();
        
        res.status(500).json({
            status: 'error',
            message: `Failed to stop project: ${error.message}`
        });
    }
});

// 错误处理中间件
app.use((err, req, res, next) => {
    if (!res.headersSent) {
        res.status(500).send('Internal Server Error');
    }
});

// 在文件顶部添加未捕获异常处理
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// 检查端口是否可用
function isPortAvailable(port) {
    return new Promise((resolve) => {
        const server = require('net').createServer();
        server.once('error', () => {
            resolve(false);
        });
        server.once('listening', () => {
            server.close();
            resolve(true);
        });
        server.listen(port);
    });
}

// 寻找可用端口
async function findAvailablePort(startPort) {
    let port = startPort;
    while (!(await isPortAvailable(port))) {
        port++;
        if (port > startPort + 100) { // 最多尝试100个端口
            throw new Error('无法找到可用端口');
        }
    }
    return port;
}

const DEFAULT_PORT = 3000;
// 清理状态文件
function cleanupStatusFile() {
    try {
        if (fs.existsSync(statusFilePath)) {
            fs.unlinkSync(statusFilePath);
        }
    } catch (error) {
        console.error('Failed to cleanup status file:', error);
    }
}

// 添加 try-catch 来捕获启动错误
async function startServer() {
    try {
        // 清理之前的状态文件
        cleanupStatusFile();
        
        // 寻找可用端口
        const port = await findAvailablePort(DEFAULT_PORT);
        
        const server = app.listen(port, () => {
            const url = `http://localhost:${port}/project-launcher.html`;
            console.log('\x1b[32m%s\x1b[0m', '服务已启动！');
            console.log('\x1b[32m%s\x1b[0m', `访问地址：${url}`);
            
            // 使用系统命令打开浏览器
            setTimeout(() => {
                const command = process.platform === 'win32' ? 
                    `start "" "${url}"` : 
                    process.platform === 'darwin' ? 
                        `open "${url}"` : 
                        `xdg-open "${url}"`;
                
                exec(command, (error) => {
                    if (error) {
                        console.error('\x1b[31m%s\x1b[0m', '打开浏览器失败：', error);
                    }
                });
            }, 1000);
        });

        // 创建 WebSocket 服务器
        const wss = new WebSocket.Server({ server });
        
        // 存储所有连接的客户端
        const clients = new Set();

        // 在进程退出时通知所有客户端
        const notifyClientsOfShutdown = () => {
            clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'shutdown' }));
                }
            });
        };

        // 统一的进程退出处理
        const handleExit = (signal) => {
            console.log(`Received ${signal}, shutting down...`);
            notifyClientsOfShutdown();
            cleanupStatusFile();
            // 给客户端一点时间处理关闭消息
            setTimeout(() => {
                process.exit(0);
            }, 100);
        };

        // 注册进程退出处理器
        ['SIGINT', 'SIGTERM'].forEach(signal => {
            process.on(signal, () => handleExit(signal));
        });

        wss.on('connection', (ws) => {
            clients.add(ws);
            console.log('WebSocket client connected');

            ws.send(JSON.stringify({ 
                type: 'status', 
                data: { 
                    connected: true,
                    projects: Array.from(runningProcesses.keys())
                }
            }));

            ws.on('close', () => {
                clients.delete(ws);
                console.log('WebSocket client disconnected');
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                clients.delete(ws);
            });
        });

        server.on('error', (error) => {
            console.error('\x1b[31m%s\x1b[0m', '服务器错误：', error);
            process.exit(1);
        });

    } catch (error) {
        console.error('\x1b[31m%s\x1b[0m', '启动失败：', error);
        process.exit(1);
    }
}

// 在服务器启动时加载状态
loadProjectStatus();

startServer();