module.exports = {
    projects: {
        template: {
            path: 'vue3.5-Template',
            command: 'pnpm dev',
            name: '广告平台 Web',
            description: '',
            nodeVersion: '22.12.0'
        },
        admin: {
            path: 'PC-admin-web',
            command: 'pnpm dev',
            name: 'Admin Web',
            description: '',
            nodeVersion: '22.12.0'
        },
        creator: {
            path: 'PC-web',
            command: 'npm run serve',
            name: '创作者中心 Web',
            description: '',
            nodeVersion: '16.20.2'
        },
        activity: {
            path: 'h5-activity-page',
            command: 'pnpm dev',
            name: '活动中心 H5',
            description: '',
            nodeVersion: '22.12.0'
        }
    }
}; 