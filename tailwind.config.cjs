module.exports = {
    content: ['./templates/**/*.html', './static/dashboard.js', './static/admin.js'],
    theme: {extend: {
        colors: {dark: '#0B0F19', panel: '#151C2C', neon: '#00F0FF', alert: '#FF003C'},
        fontFamily: {mono: ['"Courier New"', 'Courier', 'monospace'], sans: ['"Inter"', 'system-ui', 'sans-serif']}
    }},
    plugins: []
};
