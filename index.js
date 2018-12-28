"use strict";
const rp = require('request-promise');
const cheerio = require('cheerio');
const pushover = require('pushover-notifications');
const MongoClient = require('mongodb').MongoClient;
const cron = require('node-cron');
const winston = require('winston');

const debugModeStr = process.env['DEBUG'];
const isDebugMode = !!debugModeStr && (debugModeStr === '1' || debugModeStr === 'true');
const logLevel = isDebugMode ? 'debug' : 'info';

const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.splat(),
    winston.format.printf(info => `${info.timestamp}: ${info.level}: ${info.message}`)
  ),
  transports: [
    new winston.transports.Console({
      prettyPrint: true
    })
  ]
});

logger.info('Node Version: %s', process.version);
logger.info('Log Level: %s', logLevel);

class Scraper {
    constructor(baseUrl) {
        this.baseUrl = baseUrl;
        this.jar = rp.jar();
    }

    async httpReq(options) {
        if (!options.uri.startsWith('http://') && !options.uri.startsWith('https://')) {
            options.uri = this.baseUrl + options.uri;
        }

        logger.info('Running request.');
        logger.debug('%s', JSON.stringify(options, undefined, 2));

        const resultStr = await rp(options);
        logger.info('Received response.');
        logger.debug('%s', resultStr);
        return resultStr;
    }

    async jsonReq(options) {
        return JSON.parse(await this.httpReq(options));
    }

    async htmlReq(options) {
        return cheerio.load(await this.httpReq(options));
    }

    async jsonGet(uri) {
        return this.jsonReq({
            method: 'GET',
            uri,
            jar: this.jar,
            followRedirect: true,
            followAllRedirects: true,
        });
    }

    async htmlGet(uri) {
        return this.htmlReq({
            method: 'GET',
            uri,
            jar: this.jar,
            followRedirect: true,
            followAllRedirects: true,
        });
    }

    async htmlPost(uri, formData) {
        return this.htmlReq({
            method: 'POST',
            uri,
            jar: this.jar,
            followRedirect: true,
            followAllRedirects: true,
            formData,
            headers: {
                'content-type': 'application/x-www-form-urlencoded',
            }
        });
    }

    async getFormData(doc, formRoot) {
        const formEl = doc(formRoot);
        const form = {
            action: formEl.attr('action'),
            data: {},
        };

        formEl.find('input, textarea').each(function (i, elem) {
            const el = doc(this);
            form.data[el.attr('name')] = el.val();
        });

        return form;
    }
}

class DataProcessor {
    constructor(portalTenantId, portalUsername, portalPassword, mongoUrl, pushOverKey, pushOverAppToken) {
        this.baseUrl = 'https://portals.veracross.com';
        this.portalTenantId = portalTenantId;
        this.portalUsername = portalUsername;
        this.portalPassword = portalPassword;
        this.mongoUrl = mongoUrl;
        this.pushOverKey = pushOverKey;
        this.pushOverAppToken = pushOverAppToken;
    }

    async init() {
        if (!this.baseUrl) throw new Error('baseUrl is not set.');
        if (!this.portalTenantId) throw new Error('portalTenantId is not set.');
        if (!this.portalUsername) throw new Error('portalUsername is not set.');
        if (!this.portalPassword) throw new Error('portalPassword is not set.');
        if (!this.mongoUrl) throw new Error('mongoUrl is not set.');
        if (!this.pushOverKey) throw new Error('pushOverKey is not set.');
        if (!this.pushOverAppToken) throw new Error('pushOverAppToken is not set.');

        this.scraper = new Scraper(this.baseUrl + '/' + this.portalTenantId);
        this.mongoDb = await MongoClient.connect(this.mongoUrl);
        this.studentCollection = this.mongoDb.collection('Student');
        this.scoresCollection = this.mongoDb.collection('AssignmentScore');
        this.pushoverClient = new pushover({
            user: this.pushOverKey,
            token: this.pushOverAppToken,
        });
    }

    async syncLogin() {
        logger.info('Logging in.');

        // Logging in.
        const loginPage = await this.scraper.htmlGet('/');
        const loginForm = await this.scraper.getFormData(loginPage, 'form');
        loginForm.data.username = this.portalUsername;
        loginForm.data.password = this.portalPassword;

        const sessionPage = await this.scraper.htmlPost(loginForm.action, loginForm.data);
        const sessionForm = await this.scraper.getFormData(sessionPage, 'form');
        await this.scraper.htmlPost(sessionForm.action, sessionForm.data);
    }

    async syncStudents() {
        logger.info('Syncing students.');
        const students = [];

        // Figuring out the child id.
        const dashboardPage = await this.scraper.htmlGet('/parent');
        const studentEls = dashboardPage('h4.child-name').parent();

        for (let i = 0; i < studentEls.length; i += 1) {
            const studentEl = studentEls[i];
            const studentId = dashboardPage(studentEl).find('.child-links a')
                .first()
                .attr('href')
                .replace(/.*\/student\/([0-9]+)\/.*/, '$1');

            const obj = {
                _id: studentId,
                name: dashboardPage(studentEl).find('h4.child-name').text()
            };
            students.push(obj);

            logger.info('Updating student %s', JSON.stringify(obj, null, 2));
            await this.studentCollection.updateOne(
                { _id: obj._id },
                { $set: obj },
                { upsert: true }
            );
        }

        return students;
    }

    async syncAssignments(studentId) {
        logger.info('Syncing assignments for student: %s', studentId);

        // Getting course and course enrollment ids.
        const overviewPage = await this.scraper.htmlGet(`/parent/student/${studentId}/overview`);
        const courseIds = [];
        overviewPage('.course-list a.course-description').each(function() {
            const href = overviewPage(this).attr('href');
            href && courseIds.push(href.replace(/.*\/course\/([0-9]+)\/.*/, '$1'));
        });
        logger.info('Found course ids: %s', courseIds);

        const courseEnrollmentIds = [];
        overviewPage('.course-list .assignments-link').each(function() {
            const href = overviewPage(this).attr('href');
            href && courseEnrollmentIds.push(href.replace(/.*\/classes\/([0-9]+)\/assignments.*/, '$1'));
        });
        logger.info('Found course enrollment ids: %s', courseEnrollmentIds);

        // Getting assignments for each class.
        for (const enrollmentId of courseEnrollmentIds) {
            logger.info('Getting assignment scores for enrollment id: %s', enrollmentId);
            const data = await this.scraper.jsonGet(`https://portals-embed.veracross.com/${this.portalTenantId}/parent/enrollment/${enrollmentId}/assignments`);

            // Storing each assignment into the db.
            for (const assignment of data.assignments) {
                // Create the db object.
                const obj = {
                    _id: assignment.score_id,
                    enrollment_id: enrollmentId,
                    student_id: studentId,
                    data: assignment,
                };

                logger.info('Updating score with id: %s', obj._id);
                await this.scoresCollection.updateOne(
                    { _id: obj._id },
                    { $set: obj },
                    { upsert: true }
                );
            } // for
        } // for
    }

    async syncAll() {
        await this.syncLogin();

        for (const student of await this.syncStudents()) {
            logger.info('Syncing assignments for student: %s', student.name);
            await this.syncAssignments(student._id);
        }
    }

    async notifyProblems() {
        logger.info('Notifying if there are problems.');

        const studentsCursor = await this.studentCollection.find({});
        while (await studentsCursor.hasNext()) {
            const student = await studentsCursor.next();
            const query = {
                "student_id": student._id,
                "isPushOverSent": {
                    "$ne": true
                },
                "data.is_problem": 1
            };

            const assignmentScoresCursor = await this.scoresCollection.find(query);
            while (await assignmentScoresCursor.hasNext()) {
                const assignmentScore = await assignmentScoresCursor.next();
                const url = `${this.baseUrl}/${this.portalTenantId}/parent/student/${student._id}/classes/${assignmentScore.enrollment_id}/assignments`;
                const title = `${student.name} has a problem assignment.`;
                const message = `${assignmentScore.data.completion_status}, ${assignmentScore.data.assignment_description}`;
                const msgObj = {
                    title,
                    message,
                    url
                };

                logger.info('Sending pushover message: %s', message);
                await new Promise((res, rej) => this.pushoverClient.send(
                    msgObj,
                    (e) => e ? rej(e) : res()
                ));

                await this.scoresCollection.updateOne(
                    { _id: assignmentScore._id },
                    { $set: {
                        isPushOverSent: true
                    }}
                )
            }
        }
    }
}

async function initProcessor() {
  const processor = new DataProcessor(
    process.env.PORTAL_TENANT_ID,
    process.env.PORTAL_USERNAME,
    process.env.PORTAL_PASSWORD,
    process.env.MONGO_URL,
    process.env.PUSHOVER_KEY,
    process.env.PUSHOVER_APP_TOKEN,
  );

  // Attempt to connect to services.
  const connectRetryCount = 10;
  for (let i = 0; i < connectRetryCount; ++i) {
    try {
      logger.info('Attempting to connect to services.');
      await processor.init();
      break;
    } catch (e) {
      if (i === connectRetryCount - 1) {
        logger.info('Giving up on reconnecting.');
        throw new Error('Giving up on reconnecting after %s failed attempts.', connectRetryCount);
      } else {
        logger.info('Connection failed, will retry in 5 seconds.');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  return processor;
}

async function run() {
  logger.info('Running application.')

  const processor = await initProcessor();
  await processor.syncAll();
  await processor.notifyProblems();
  logger.info('Application run complete.');
}

async function main() {
  if (process.env['SKIP_START']) {
    return;
  }

  logger.info('Initializing processor to test this all will work.');
  await initProcessor();
  logger.info('Processor initialization test successful.');

  logger.info('Scheduling run.')
  cron.schedule('0 5,17,21 * * *', async function() {
    try {
      await run();
    } catch (err) {
      logger.error('%s', err);
    }
  });
}

main();

