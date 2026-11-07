**leafi is installed.** If the installer (`install.sh` or
`install.ps1`) is installing it, your settings are already saved and it
finishes on its own.

If you haven't already setup the provider, run:

```bash
node ~/.hermes/plugins/leafi/dist/server.mjs init
```

You can ask your agent anytime to setup an automation, and the automation flow created will be saved. Your agent can design and optimize the flow from there.

To change the settings and permissions for the agents, you can run: 

```bash
node ~/.hermes/plugins/leafi/dist/server.mjs settings
```

