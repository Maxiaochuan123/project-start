const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('./config');

async function startProject(projectPath, command, nodeVersion) {
    try {
        // 首先尝试在当前目录查找项目
        const currentDirPath = path.join(process.cwd(), projectPath);
        // 如果当前目录不存在，则尝试桌面路径
        const desktopPath = path.join(process.env.USERPROFILE, 'Desktop');
        const desktopFullPath = path.join(desktopPath, projectPath);
        
        // 确定实际的项目路径
        const fullPath = fs.existsSync(currentDirPath) ? currentDirPath : 
                        fs.existsSync(desktopFullPath) ? desktopFullPath : null;
        
        if (!fullPath) {
            throw new Error(`Project path not found: ${projectPath}`);
        }

        // 创建临时的 nvm 切换脚本
        const nvmBatchFile = path.join(process.cwd(), `nvm_switch_${Date.now()}.bat`);
        const nvmBatchContent = `@echo off
set "PATH=%PATH%;%APPDATA%\\nvm;%ProgramFiles%\\nodejs"
for /f "tokens=*" %%i in ('"%SystemRoot%\\System32\\cmd.exe" /c "nvm current"') do set current=%%i
echo Current version: %current% | findstr "${nodeVersion}" > nul
if %errorlevel% equ 0 (
    exit 0
)
start "NVM Switcher" /wait "%SystemRoot%\\System32\\cmd.exe" /c "nvm use ${nodeVersion}"
`;
        fs.writeFileSync(nvmBatchFile, nvmBatchContent);

        // 执行 Node.js 版本切换
        await new Promise((resolve, reject) => {
            exec(nvmBatchFile, (error, stdout, stderr) => {
                try {
                    fs.unlinkSync(nvmBatchFile);
                } catch (err) {
                    console.error('Failed to cleanup nvm batch file:', err);
                }

                if (error) {
                    reject(new Error(`Failed to switch Node version: ${error.message}`));
                    return;
                }
                resolve();
            });
        });

        // 启动项目，不使用 detached 模式
        const child = exec(command, {
            cwd: fullPath,
            env: { ...process.env, FORCE_COLOR: true },
            windowsHide: true, // 在 Windows 上隐藏命令提示符窗口
            shell: true // 使用 shell 执行命令
        });

        let projectUrl = null;
        let fullOutput = '';

        child.stdout.on('data', (data) => {
            const output = data.toString();
            process.stdout.write(data);
            fullOutput += output;

            // 检测开发服务器URL模式
            const patterns = [
                /\s+- Local:\s+(http:\/\/localhost:[0-9]+\/)/,
                /App running at:\s*[\r\n]+\s+- Local:\s+(http:\/\/localhost:[0-9]+\/)/,
                /Your application is running here: (http:\/\/localhost:[0-9]+)/
            ];

            if (!projectUrl) {
                for (const pattern of patterns) {
                    const match = output.match(pattern) || fullOutput.match(pattern);
                    if (match) {
                        projectUrl = match[1].trim();
                        // 写入状态文件
                        const statusFile = path.join(process.cwd(), 'server_status.txt');
                        fs.writeFileSync(statusFile, JSON.stringify({
                            project,
                            url: projectUrl,
                            status: 'running'
                        }));
                        break;
                    }
                }
            }
        });

        child.stderr.on('data', (data) => {
            process.stderr.write(data);
        });

        child.on('error', (error) => {
            console.error(`Project startup error: ${error.message}`);
            process.exit(1);
        });

        child.on('exit', (code) => {
            if (code !== 0) {
                console.error(`Project exited with code ${code}`);
            }
            // 清理状态文件
            try {
                fs.unlinkSync(path.join(process.cwd(), 'server_status.txt'));
            } catch (err) {
                console.error('Failed to cleanup status file:', err);
            }
            process.exit(code || 0);
        });

        return child;
    } catch (error) {
        console.error(`Failed to start project: ${error.message}`);
        process.exit(1);
    }
}

// 获取命令行参数并启动项目
const project = process.argv[2];
if (!project) {
    console.error('Project name is required');
    process.exit(1);
}

if (config.projects[project]) {
    const { path: projectPath, command, nodeVersion } = config.projects[project];
    startProject(projectPath, command, nodeVersion).catch(error => {
        console.error(error);
        process.exit(1);
    });
} else {
    console.error('Available projects:', Object.keys(config.projects).join(', '));
    process.exit(1);
}