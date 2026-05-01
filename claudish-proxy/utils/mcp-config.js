module.exports = {
    mcpServers: [
        {
            name: 'minimax',
            // Uses uvx to run the python-based minimax MCP server
            command: 'uvx',
            args: ['minimax-coding-plan-mcp'],
            env: { 
                // Ensure this matches the endpoint you are using
                MINIMAX_API_HOST: 'https://api.minimax.io', 
                // The proxy passes its key down if needed, but you can hardcode here if preferred
                MINIMAX_API_KEY: process.env.MINIMAX_API_KEY || ''
            }
        },
        {
            name: 'filesystem',
            // Node-based filesystem server
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/Users/rober/LocalFolders']
        },
        {
            name: 'fetch',
            // Clean markdown web fetching
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-fetch']
        }
    ]
};
