const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('./config');

function startProject(projectPath, command) {
    // 首先尝试在当前目录查找项目
    const currentDirPath = path.join(process.cwd(), projectPath);
    // 如果当前目录不存在，则尝试桌面路径
    const desktopPath = path.join(process.env.USERPROFILE, 'Desktop');
    const desktopFullPath = path.join(desktopPath, projectPath);
    
    // 确定实际的项目路径
    const fullPath = fs.existsSync(currentDirPath) ? currentDirPath : 
                    fs.existsSync(desktopFullPath) ? desktopFullPath : null;
    
    if (!fullPath) {
        const error = `Project path not found in current directory or desktop: ${projectPath}`;
        throw new Error(error);
    }
    
    const child = exec(command, {
        cwd: fullPath,
        env: { ...process.env, FORCE_COLOR: true }
    });

    // 用于存储项目URL的变量
    let projectUrl = null;
    // 存储完整的输出用于多行匹配
    let fullOutput = '';

    child.stdout.on('data', (data) => {
        const output = data.toString();
        // 输出到控制台
        process.stdout.write(data);
        
        // 追加到完整输出
        fullOutput += output;

        // 检测开发服务器URL模式
        const patterns = [
            // Vue CLI 标准输出格式
            /\s+- Local:\s+(http:\/\/localhost:[0-9]+\/)/,
            // 备用格式
            /App running at:\s*[\r\n]+\s+- Local:\s+(http:\/\/localhost:[0-9]+\/)/,
            /Your application is running here: (http:\/\/localhost:[0-9]+)/
        ];

        // 如果还没有找到URL
        if (!projectUrl) {
            // 首先尝试从当前输出行匹配
            for (const pattern of patterns) {
                const match = output.match(pattern);
                if (match) {
                    projectUrl = match[1].trim();
                    break;
                }
            }

            // 如果当前行没找到，尝试从累积的输出中匹配
            if (!projectUrl) {
                for (const pattern of patterns) {
                    const match = fullOutput.match(pattern);
                    if (match) {
                        projectUrl = match[1].trim();
                        break;
                    }
                }
            }

            // 如果找到了URL，写入状态文件
            if (projectUrl) {
                const statusFile = path.join(process.cwd(), 'server_status.txt');
                fs.writeFileSync(statusFile, JSON.stringify({
                    project,
                    url: projectUrl,
                    status: 'running'
                }));
            }
        }
    });

    child.stderr.on('data', (data) => {
        process.stderr.write(data);
    });

    child.on('error', (error) => {
    });

    child.on('exit', (code) => {
        // 清理状态文件
        try {
            fs.unlinkSync(path.join(process.cwd(), 'server_status.txt'));
        } catch (err) {
            // 忽略文件不存在的错误
        }
    });

    return child;
}

// 获取命令行参数
const project = process.argv[2];

if (config.projects[project]) {
    const { path: projectPath, command } = config.projects[project];
    startProject(projectPath, command);
} else {
    console.log('Available projects:', Object.keys(config.projects).join(', '));
}