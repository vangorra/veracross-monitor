# veracross-monitor
Looks for problem assignments in veracross and sends a notification.

Veracross is school management software, the software provides a parent portal for manaing your student 
and checking their progress. Sadly, veracross doesn't support parent notifications (yet). This simple 
tool will priodically login to the parent portal, check for assignments that have problems 
(not turned in, late, incomplete, etc) and send a notification to your phone using the pushover service.

## Requirements
- Technical know how. If you don't understand how to set this up, then you shouldn't be doing it.
- docker-compose
- Pushover account. https://pushover.net/

## Docker Compose setup

#### .env
Configuration for docker-compose.
```
PORTAL_TENANT_ID=# Found in https://accounts.veracross.com/<TENNANT_ID>/portals/login
PORTAL_USERNAME=# Username for logging into the portal.
PORTAL_PASSWORD=# Password for logging into the portal.
PUSHOVER_KEY=# From the pushover website.
PUSHOVER_APP_TOKEN=# For the specific application on the pushover website.
# All this is used to configure the internal mongo service. It's not accessable to anything but
# the veracross monitor app. So we aren't too concerened about security here.
MONGO_USERNAME=admin
MONGO_PASSWORD=password
MONGO_DB=veracross-monitor-data
```

#### docker-compose.yml
``` yaml
version: '2'
services:
  app:
    #build: '../git/veracross-monitor'
    image: 'vangorra/veracross-monitor'
    restart: 'always'
    environment:
      PORTAL_TENANT_ID: '${PORTAL_TENANT_ID}'
      PORTAL_USERNAME: '${PORTAL_USERNAME}'
      PORTAL_PASSWORD: '${PORTAL_PASSWORD}'
      PUSHOVER_KEY: '${PUSHOVER_KEY}'
      PUSHOVER_APP_TOKEN: '${PUSHOVER_APP_TOKEN}'
      MONGO_URL: 'mongodb://${MONGO_USERNAME}:${MONGO_PASSWORD}@mongodb/${MONGO_DB}'
      DEBUG: '0'
    depends_on:
      - 'mongodb'
  mongodb:
    image: 'mongo'
    restart: 'always'
    volumes:
      - './container_data/mongodb/db:/data/db:rw'
      - './container_data/mongodb/entrypoint.d:/docker-entrypoint-initdb.d:ro'
    environment:
      MONGO_INITDB_ROOT_USERNAME: '${MONGO_USERNAME}'
      MONGO_INITDB_ROOT_PASSWORD: '${MONGO_PASSWORD}'
      MONGO_INITDB_DATABASE: '${MONGO_DB}'
```

### container_data/mongodb/entrypoint.d/001_users.sh
This is used to create the initial database and user when mongo first starts.
```bash
mongo -- "$MONGO_INITDB_DATABASE" <<EOF
var user = '$MONGO_INITDB_ROOT_USERNAME';
var passwd = '$MONGO_INITDB_ROOT_PASSWORD';
var admin = db.getSiblingDB('admin');

admin.auth(user, passwd);
db.createUser(
    {
        user: '$MONGO_INITDB_ROOT_USERNAME',
        pwd: '$MONGO_INITDB_ROOT_PASSWORD',
        roles:[
            {
                role: 'readWrite',
                db: '$MONGO_INITDB_DATABASE'
            }
        ]
    }
);

EOF
```
