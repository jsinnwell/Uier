'use strict';

const settings = require('../../settings');
const bcrypt = require('bcrypt');
const { transaction } = require('objection');
const { ref } = require('objection');

const User = require('../models/User');
const UserRole = require('../models/UserRole');
const Test = require('../models/Test');
const TestStep = require('../models/TestStep');
const Collection = require('../models/Collection');
const CollectionTest = require('../models/CollectionTest');
const Run = require('../models/Run');
const RunStep = require('../models/RunStep');

module.exports = router => {

    // --- Authentication ---
    router.post('/login', async(req, res) => {
        if (!req.query.username || !req.query.password) {
            return res.send({ status: "failed" });
        }
        if (req.session.user) {
            return res.send({ status: "already logged on" })
        }
        // Pull user record
        const users = await User.query()
            .where({ email: req.query.username })
            .eager('roles')
            .omit(UserRole, ['id', 'user'])
            .first()
            // Check password
        if (users && bcrypt.compareSync(req.query.username + req.query.password + settings.shared.server_password_salt, users.password)) {
            req.session.organization = users.organization;
            req.session.user = {
                id: users.id,
                uid: users.uid,
                name: users.name,
                email: users.email
            }
            req.session.roles = users.roles.map(function(role) { return role.role });
            return res.send({ status: "authenticated", user: req.session.user, roles: req.session.roles });
        } else {
            return res.send({ status: "bad_credentials" });
        }
    });

    router.post('/authenticated', async(req, res) => {
        if (req.session.user) {
            res.send({ status: "authenticated", user: req.session.user, roles: req.session.roles })
        } else {
            res.send({ status: "not_authenticated" })
        }
    });

    router.patch('/password', async(req, res) => {
        if (req.session && req.session.user) {
            let updatedUsers;
            // Allows the logged in user only to change their password.
            const users = await User.query().findOne({ uid: req.session.user.uid });
            // Check current password and update if correct
            if (users && bcrypt.compareSync(users.email + req.body.old + settings.shared.server_password_salt, users.password)) {
                await users.$query().patchAndFetch({ password: bcrypt.hashSync(users.email + req.body.new + settings.shared.server_password_salt, 10) });
                res.send({ message: "Password changed." });
            } else {
                res.send({ error: "Old password does not match." });
            }
        } else {
            res.send({ status: "not_authenticated" });
        }
    });

    router.post('/logout', async(req, res) => {
        req.session.destroy();
        res.send({ status: "not_authenticated" });
    });


    // --- User ---

    router.get('/user', (req, res, next) => checkPermission(req, res, next, "user_read"), async(req, res) => {
        const users = await User.query()
            .where({ organization: req.session.organization })
            .eager('roles')
            .omit(User, ['id', 'organization', 'password'])
            .omit(UserRole, ['id', 'user'])
            .orderBy('users.email', 'asc')
        res.send(users);
    });

    router.get('/user/:uid', (req, res, next) => checkPermission(req, res, next, "user_read"), async(req, res) => {
        const users = await User.query().findOne({ uid: req.params.uid })
            .eager('roles')
            .omit(User, ['id', 'organization', 'password'])
            .omit(UserRole, ['id', 'user'])
        res.send(users);
    });

    router.post('/user', (req, res, next) => checkPermission(req, res, next, "user_add"), async(req, res) => {
        const graph = req.body;
        graph.organization = req.session.organization;
        graph.password = bcrypt.hashSync(graph.email + graph.password + settings.shared.server_password_salt, 10);
        const insertedGraph = await transaction(User.knex(), trx => {
            return (
                User.query(trx)
                .allowInsert('[roles]')
                .insertGraph(graph)
            );
        });
        const users = await User.query()
            .findById(insertedGraph.id)
            .where({ organization: req.session.organization })
            .eager('roles')
            .omit(User, ['id', 'organization', 'password'])
            .omit(UserRole, ['id', 'user'])
        res.send(users);
    });

    router.put('/user/:uid', (req, res, next) => checkPermission(req, res, next, "user_update"), async(req, res) => {
        // Allows a user with the right permission to change all details of a user
        // Find current user ID
        const users = await User.query()
            .findOne({ uid: req.params.uid })
            .where({ organization: req.session.organization })
            .select('id')
            // Create update object
        const graph = req.body;
        graph.id = users.id;
        if (graph.password) {
            graph.password = bcrypt.hashSync(graph.email + graph.password + settings.shared.server_password_salt, 10);
        } else {
            delete graph.password;
        }
        graph.organization = req.session.organization;
        // Update
        const insertedGraph = await transaction(User.knex(), trx => {
            return (
                User.query(trx)
                .findOne({ uid: req.params.uid }).where({ organization: req.session.organization })
                .omit(User, ['password'])
                .allowUpsert('[roles]')
                .upsertGraph(graph, {})
                .omit(User, ['id', 'organization', 'password'])
                .omit(UserRole, ['id', 'user'])
            );
        });
        res.send(insertedGraph);
    });

    router.delete('/user/:uid', (req, res, next) => checkPermission(req, res, next, "user_delete"), async(req, res) => {
        const numberOfDeletedRows = await User.query().delete().where('uid', req.params.uid).where({ organization: req.session.organization });
        res.send({ numberOfDeletedRows: numberOfDeletedRows });
    });

    // --- Test ---

    router.get('/test', (req, res, next) => checkPermission(req, res, next, "test_read"), async(req, res) => {
        const tests = await Test.query()
            .where({ organization: req.session.organization })
            .omit(Test, ['id', 'organization'])
            .leftJoin('tests_steps', function() {
                this.on('tests_steps.test', '=', 'tests.id')
            })
            .select(
                [
                    'tests.uid',
                    'tests.name',
                    'tests.purpose',
                    'tests.browser',
                    'tests.urlDomain',
                    'tests.urlPath',
                    Run.query().where({ organization: req.session.organization, test: ref('tests.uid') }).orderBy('created', 'desc').first().select(['uid']).as('run_uid'),
                    Run.query().where({ organization: req.session.organization, test: ref('tests.uid') }).orderBy('created', 'desc').first().select(['status']).as('run_status')
                ])
            .groupBy(['tests.uid'])
            .count({ 'stepCount': 'tests_steps.id' })
            .orderBy('tests.name', 'asc')
        res.send(tests);
    });

    router.get('/test_dropdown', (req, res, next) => checkPermission(req, res, next, "collection_read"), async(req, res) => {
        // Used to define a collection
        const tests = await Test.query()
            .where({ organization: req.session.organization })
            .omit(Test, ['id', 'organization'])
            .select(
                [
                    'tests.uid',
                    'tests.name',
                    'tests.purpose',
                    'tests.browser',
                    'tests.urlDomain',
                    'tests.urlPath'
                ])
            .groupBy(['tests.uid'])
        res.send(tests);
    });

    router.get('/test/:uid', (req, res, next) => checkPermission(req, res, next, "test_read"), async(req, res) => {
        const tests = await Test.query()
            .findOne({ uid: req.params.uid })
            .where({ organization: req.session.organization })
            .select(
                [
                    'tests.uid',
                    'tests.name',
                    'tests.purpose',
                    'tests.browser',
                    'tests.urlDomain',
                    'tests.urlPath',
                    Run.query().where({ organization: req.session.organization, test: ref('tests.uid') }).orderBy('created', 'desc').first().select(['uid']).as('run_uid'),
                    Run.query().where({ organization: req.session.organization, test: ref('tests.uid') }).orderBy('created', 'desc').first().select(['status']).as('run_status')
                ])
            .eager('steps')
            .groupBy(['tests.uid'])
            .omit(TestStep, ['id', 'test'])
        res.send(tests);
    });

    router.post('/test', (req, res, next) => checkPermission(req, res, next, "test_add"), async(req, res) => {
        const graph = req.body;
        graph.organization = req.session.organization;
        const insertedGraph = await transaction(Test.knex(), trx => {
            return (
                Test.query(trx)
                .allowInsert('[steps]')
                .insertGraph(graph)
            );
        });
        const tests = await Test.query()
            .findById(insertedGraph.id)
            .where({ organization: req.session.organization })
            .eager('steps')
            .omit(Test, ['id', 'organization'])
            .omit(TestStep, ['id', 'test'])
        res.send(tests);
    });

    router.put('/test/:uid', (req, res, next) => checkPermission(req, res, next, "test_update"), async(req, res) => {
        // Find current test ID
        const tests = await Test.query()
            .findOne({ uid: req.params.uid })
            .where({ organization: req.session.organization })
            .select('id')
            // Create update object
        const graph = req.body;
        graph.id = tests.id;
        graph.organization = req.session.organization;
        // Update
        const insertedGraph = await transaction(Test.knex(), trx => {
            return (
                Test.query(trx)
                .findOne({ uid: req.params.uid }).where({ organization: req.session.organization })
                .allowUpsert('[steps]')
                .upsertGraph(graph, {})
                .omit(Test, ['id', 'organization'])
                .omit(TestStep, ['id', 'test'])
            );
        });
        res.send(insertedGraph);
    });

    router.delete('/test/:uid', (req, res, next) => checkPermission(req, res, next, "test_delete"), async(req, res) => {
        const numberOfDeletedRows = await Test.query()
            .delete()
            .where('uid', req.params.uid)
            .where({ organization: req.session.organization });
        res.send({ numberOfDeletedRows: numberOfDeletedRows });
    });


    // --- Collection ---

    router.get('/collection', (req, res, next) => checkPermission(req, res, next, "collection_read"), async(req, res) => {
        const collections = await Collection.query()
            .where({ organization: req.session.organization })
            .omit(Collection, ['id', 'organization'])
            .leftJoin('collections_tests', function() {
                this.on('collections_tests.collection', '=', 'collections.id')
            })
            .select(['collections.uid', 'collections.name', 'collections.description'])
            .groupBy(['collections.uid'])
            .count({ 'testCount': 'collections_tests.id' })
            .orderBy('collections.name', 'asc')
        res.send(collections);
    });

    router.get('/collection/:uid', (req, res, next) => checkPermission(req, res, next, "collection_read"), async(req, res) => {
        // Get collection
        const collections = await Collection.query()
            .findOne({ 'collections.uid': req.params.uid })
            .where({ 'collections.organization': req.session.organization })
            .omit(Collection, ['id', 'organization'])
            // Get tests and their results
        collections.tests = await CollectionTest.query()
            .leftJoin('collections', function() {
                this.on('collections_tests.collection', '=', 'collections.id')
            })
            .where({ 'collections.organization': req.session.organization, 'collections.uid': collections.uid })
            .select([
                'test',
                'browser',
                'urlDomain',
                Run.query().where({ organization: req.session.organization, test: ref('collections_tests.test'), browser: ref('collections_tests.browser'), urlDomain: ref('collections_tests.urlDomain') }).orderBy('created', 'desc').first().select(['uid']).as('run_uid'),
                Run.query().where({ organization: req.session.organization, test: ref('collections_tests.test'), browser: ref('collections_tests.browser'), urlDomain: ref('collections_tests.urlDomain') }).orderBy('created', 'desc').first().select(['status']).as('run_status')
            ])
        res.send(collections);
    });

    router.post('/collection', (req, res, next) => checkPermission(req, res, next, "collection_add"), async(req, res) => {
        const graph = req.body;
        graph.organization = req.session.organization;
        const insertedGraph = await transaction(Collection.knex(), trx => {
            return (
                Collection.query(trx)
                .allowInsert('[tests]')
                .insertGraph(graph)
            );
        });
        const collections = await Collection.query()
            .findById(insertedGraph.id)
            .where({ organization: req.session.organization })
            .eager('tests')
            .omit(Collection, ['id', 'organization'])
            .omit(CollectionTest, ['id', 'collection'])
        res.send(collections);
    });

    router.put('/collection/:uid', (req, res, next) => checkPermission(req, res, next, "collection_update"), async(req, res) => {
        // Find current collection ID
        const collections = await Collection.query()
            .findOne({ uid: req.params.uid })
            .where({ organization: req.session.organization })
            .select('id')
            // Create update object
        const graph = req.body;
        graph.id = collections.id;
        graph.organization = req.session.organization;
        // Update
        const insertedGraph = await transaction(Collection.knex(), trx => {
            return (
                Collection.query(trx)
                .findOne({ uid: req.params.uid }).where({ organization: req.session.organization })
                .allowUpsert('[tests]')
                .upsertGraph(graph, {})
                .omit(Collection, ['id', 'organization'])
                .omit(CollectionTest, ['id', 'collection'])
            );
        });
        res.send(insertedGraph);
    });

    router.delete('/collection/:uid', (req, res, next) => checkPermission(req, res, next, "collection_delete"), async(req, res) => {
        const numberOfDeletedRows = await Collection.query()
            .delete()
            .where('uid', req.params.uid)
            .where({ organization: req.session.organization });
        res.send({ numberOfDeletedRows: numberOfDeletedRows });
    });


    // --- Run ---

    router.get('/run', (req, res, next) => checkPermission(req, res, next, "run_read"), async(req, res) => {
        const runs = await Run.query()
            .where({ 'runs.organization': req.session.organization })
            .omit(Run, ['id', 'organization'])
            .leftJoin('tests', function() {
                this.on('runs.test', '=', 'tests.uid')
            })
            .orderBy('runs.created', 'desc')
            .select([
                'runs.uid',
                'runs.test',
                { 'test_name': 'tests.name' },
                { 'test_purpose': 'tests.purpose' },
                'runs.created',
                'runs.status',
                'runs.browser',
                'runs.urlDomain',
                'runs.start',
                'runs.end'
            ]);

        res.send(runs);
    });

    router.get('/run/next', (req, res, next) => checkPermission(req, res, next, "RUNNER"), async(req, res) => {
        var runs = await Run.query()
            .where({ status: "new" })
            .first()
            .leftJoin('tests', function() {
                this.on('runs.test', '=', 'tests.uid');
            })
            .select([
                'runs.uid',
                'runs.test',
                'runs.created',
                'runs.status',
                'runs.browser',
                'runs.urlDomain',
                'tests.urlPath',
                'runs.start',
                'runs.end'
            ])
            .omit(Run, ['id', 'organization'])
        if (runs) {
            runs.steps = await TestStep.query()
                .join('tests', function() {
                    this.on('tests_steps.test', '=', 'tests.id');
                })
                .where({ 'tests.uid': runs.test })
                .omit(TestStep, ['id', 'test'])
        } else {
            runs = {};
        }
        res.send(runs);
    });

    router.patch('/run/:uid', (req, res, next) => checkPermission(req, res, next, "RUNNER"), async(req, res) => {
        const runs = await Run.query().findOne({ uid: req.params.uid });
        let updatedRuns;
        if (runs) {
            await runs.$query().patchAndFetch({
                status: req.body.status,
                start: req.body.start
            });
            updatedRuns = { message: "Run started." }
        } else {
            updatedRuns = { error: "Run not found." }
        }
        res.send(updatedRuns);
    });

    router.get('/run/:uid', (req, res, next) => checkPermission(req, res, next, "run_read"), async(req, res) => {
        const runs = await Run.query()
            .findOne({ 'runs.uid': req.params.uid })
            .where({ 'runs.organization': req.session.organization })
            .eager('steps')
            .omit(Run, ['id', 'organization'])
            .omit(RunStep, ['id', 'run'])
            .leftJoin('tests', function() {
                this.on('runs.test', '=', 'tests.uid')
            })
            .select([
                'runs.uid',
                'runs.test',
                { 'test_name': 'tests.name' },
                { 'test_purpose': 'tests.purpose' },
                'runs.created',
                'runs.status',
                'runs.browser',
                'runs.urlDomain',
                'runs.start',
                'runs.end'
            ]);
        res.send(runs);
    });

    router.post('/test/:uid/run', (req, res, next) => checkPermission(req, res, next, "test_run"), async(req, res) => {
        const insert = await Run.query().insert({
            organization: req.session.organization,
            test: req.params.uid,
            browser: req.body.browser,
            urlDomain: req.body.urlDomain
        });
        const runsResult = await Run.query()
            .findById(insert.id)
            .where({ organization: req.session.organization })
            .omit(Run, ['id', 'organization'])
        res.send(runsResult);
    });

    router.post('/collection/:uid/run', (req, res, next) => checkPermission(req, res, next, "collection_run"), async(req, res) => {
        // Get a list of all tests from this collection
        const collections = await Collection.query()
            .findOne({ uid: req.params.uid })
            .where({ organization: req.session.organization })
            .eager('tests');
        var output = [];
        for (var c = 0; c < collections.tests.length; c++) {
            var collection = collections.tests[c];
            var insert = await Run.query().insert({
                organization: req.session.organization,
                test: collection.test,
                browser: collection.browser,
                urlDomain: collection.urlDomain
            });
            var runsResult = await Run.query()
                .findById(insert.id)
                .where({ organization: req.session.organization })
                .omit(Run, ['id', 'organization'])
            output.push(runsResult);
        }
        res.send(output)
    });

    router.put('/run/:uid', (req, res, next) => checkPermission(req, res, next, "RUNNER"), async(req, res) => {
        // Find current run ID
        const runs = await Run.query()
            .findOne({ uid: req.params.uid })
            .select('id')
            // Create update object
        const graph = req.body;
        graph.id = runs.id;
        // Update
        const insertedGraph = await transaction(Run.knex(), trx => {
            return (
                Run.query(trx)
                .findOne({ uid: req.params.uid })
                .allowUpsert('[steps]')
                .upsertGraph(graph, {})
                .omit(Run, ['id', 'organization'])
                .omit(RunStep, ['id', 'test'])
            );
        });
        res.send(insertedGraph);
    });

    router.delete('/run/:uid', (req, res, next) => checkPermission(req, res, next, "run_delete"), async(req, res) => {
        const numberOfDeletedRows = await Run.query()
            .delete()
            .where('uid', req.params.uid)
            .where({ organization: req.session.organization });
        res.send({ numberOfDeletedRows: numberOfDeletedRows });
    });


};

function checkPermission(req, res, next, requiredRole) {

    if (req.headers["x-runner"] && bcrypt.compareSync(settings.shared.runner_secret, req.headers["x-runner"])) {
        // Runner
        return next();
    } else if (req.session && req.session.roles && req.session.roles.includes(requiredRole)) {
        // User role
        return next();
    } else {
        // No permission
        return res.sendStatus(401);
    }
}


// The error returned by this function is handled in the error handler middleware in app.js.
function createStatusCodeError(statusCode) {
    return Object.assign(new Error(), {
        statusCode
    });
}