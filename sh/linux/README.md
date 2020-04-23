# Manta Server Linux Init Script

_Complete the following steps after installing node-manta:_

Step 1 - Install Node Forever: 
```
npm -g install forever
```

Step 2 - Grab the init script from init.d and copy to your */etc/init.d* as root, then chmod the file:
```
chomd 0755 manta-server
```

Step 3 - Update system service definitions:
```
update-rc.d manta-server defaults
```

Step 4 - Then add your environment variables to the persistent scope *vi /etc/environment* and add the following lines:
```
MANTA_KEY_ID="Key Id (can be found in your account settings SSH Keys)"
MANTA_URL="https://us-east.manta.joyent.com" 
MANTA_USER="Your username"
```

Step 5 - Then source the env vars:
```
source /etc/environment
```

Step 6 - Last but not least, create your log folder:
```
mkdir /var/log/manta-server;
touch /var/log/manta-server/error.log;
```

Step 7 - Now you're ready to run it: 
```
/etc/init.d/manta-server (start|stop|restart)
```
