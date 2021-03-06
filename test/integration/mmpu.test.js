/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * Test `mmpu` workflow: create an upload, upload a part, get the upload,
 * and then commit it. Repeat the same process for abort.
 *
 * We also check that the `list` and `parts` subcommands output what we expect
 * at various points in the process.
 */

var assert = require('assert-plus');
var crypto = require('crypto');
var forkExecWait = require('forkexec').forkExecWait;
var format = require('util').format;
var fs = require('fs');
var libuuid = require('uuid');
var path = require('path');
var test = require('tap').test;
var vasync = require('vasync');

var logging = require('../lib/logging');
var testutils = require('../lib/utils');
var manta = require('../../lib');


// ---- globals

var log = logging.createLogger();

var MANTA_USER = process.env.MANTA_USER || 'admin';

var BINDIR = path.resolve(__dirname, '../../bin');
var MGET = path.resolve(BINDIR, 'mget');
var MMPU = path.resolve(BINDIR, 'mmpu');
var MRM = path.resolve(BINDIR, 'mrm');

// mmpu subcommands
var CREATE = 'create';
var UPLOAD = 'upload';
var GET = 'get';
var LIST = 'list';
var PARTS = 'parts';
var ABORT = 'abort';
var COMMIT = 'commit';

// object paths
var C_OBJ_PATH = format('/%s/stor/node-manta-test-mmpu-%s-commit',
    MANTA_USER, MANTA_USER);
var A_OBJ_PATH = format('/%s/stor/node-manta-test-mmpu-%s-abort',
    MANTA_USER, MANTA_USER);

// upload ids
var C_ID;
var A_ID;

// upload paths
var C_UPLOADPATH;
var A_UPLOADPATH;

// part etags
var C_ETAG0;
var A_ETAG0;

// object to upload
var TEXT = 'asdfghjk;';
var TEXT_SIZE = TEXT.length.toString();
var TEXT_MD5 = crypto.createHash('md5').update(TEXT).digest('base64');

var testOpts = {
    skip: !testutils.isMpuEnabledSync(log) &&
        'this Manta does not support multipart upload (MPU)'
};


// ---- tests

test('mmpu', testOpts, function (suite) {

    // Exercise all possible create flags here.
    suite.test('mmpu create C_OBJ_PATH -c 1 -H m-custom-header:foo ' +
            '-s TEXT_SIZE -m TEXT_MD5', function (t) {
        var argv = [
            MMPU, CREATE, C_OBJ_PATH,
            '-c', '1',
            '-H', 'm-custom-header:foo',
            '-s', TEXT_SIZE,
            '-m', TEXT_MD5
        ];

        forkExecWait({
            argv: argv
        }, function (err, info) {
            t.ifError(err, err);
            if (!err) {
                t.ok(info);
                t.ok(info.stdout);
                C_ID = info.stdout.replace('\n', '');
            }
            t.end();
        });
    });

    // Get the upload we are going to commit, and verify the attributes match
    // what was specified on create.
    suite.test('mmpu get C_ID', function (t) {
        var argv = [ MMPU, GET, C_ID ];

        forkExecWait({
            argv: argv
        }, function (err, info) {
            t.ifError(err, err);
            if (!err) {
                t.ok(info);
                var upload = JSON.parse(info.stdout);
                t.ok(upload);
                if (!upload) {
                    t.end();
                    return;
                }

                var headers = upload.headers;
                t.ok(headers);
                if (!headers) {
                    t.end();
                    return;
                }

                t.equal(headers['durability-level'], 1);
                t.equal(headers['content-length'], Number(TEXT_SIZE));
                t.equal(headers['content-md5'], TEXT_MD5);
                t.equal(headers['m-custom-header'], 'foo');
                t.equal(upload.state, 'created');

                C_UPLOADPATH = upload.partsDirectory;
            } else {
                console.log(err);
                console.log(info.stderr);
            }

            t.end();
        });
    });


    // Check that the values specified as flags overwrite the header values.
    suite.test('mmpu create A_OBJ_PATH -c 1 -s TEXT_SIZE -m TEXT_MD5' +
            '-H durability-level 3 -H content-length:10 -H content-md5:foo',
            function (t) {
        var argv = [
            MMPU, CREATE, A_OBJ_PATH,
            '-c', '1',
            '-s', TEXT_SIZE,
            '-m', TEXT_MD5,
            '-H', 'durability-level:3',
            '-H', 'content-length:10',
            '-H', 'content-md5:foo'
        ];

        forkExecWait({
            argv: argv
        }, function (err, info) {
            t.ifError(err, err);
            if (!err) {
                t.ok(info);
                t.ok(info.stdout);
                A_ID = info.stdout.replace('\n', '');
            }
            t.end();
        });
    });


    // Get the upload we are going to abort, and verify the attributes match
    // what was specified on create.
    suite.test('mmpu get A_ID', function (t) {
        var argv = [ MMPU, GET, A_ID ];

        forkExecWait({
            argv: argv
        }, function (err, info) {
            t.ifError(err, err);
            if (!err) {
                t.ok(info);
                var upload = JSON.parse(info.stdout);
                t.ok(upload);
                if (!upload) {
                    t.end();
                    return;
                }

                var headers = upload.headers;
                if (!headers) {
                    t.end();
                    return;
                }

                t.ok(headers);
                t.equal(headers['durability-level'], 1);
                t.equal(headers['content-length'], Number(TEXT_SIZE));
                t.equal(headers['content-md5'], TEXT_MD5);
                t.equal(upload.state, 'created');

                A_UPLOADPATH = upload.partsDirectory;
            } else {
                console.log(err);
                console.log(info.stderr);
            }

            t.end();
        });

    });

    // Check that no parts have been uploaded for C_ID.
    suite.test('mmpu parts C_ID: pre-upload', function (t) {
        var argv = [ MMPU, PARTS, C_ID ];

        forkExecWait({
            argv: argv
        }, function (err, info) {
            t.ifError(err, err);
            if (!err) {
                t.equal(info.stdout, '');
            } else {
                console.log(err);
                console.log(info.stderr);
            }

            t.end();
        });
    });

    // Check that no parts have been uploaded for A_ID.
    suite.test('mmpu parts A_ID: pre-upload', function (t) {
        var argv = [ MMPU, PARTS, A_ID ];

        forkExecWait({
            argv: argv
        }, function (err, info) {
            t.ifError(err, err);
            if (!err) {
                t.equal(info.stdout, '');
            } else {
                console.log(err);
                console.log(info.stderr);
            }

            t.end();
        });
    });

    // Check that we see the new uploads in `mmpu list`.
    suite.test('mmpu list', function (t) {
        var argv = [ MMPU, LIST ];

        forkExecWait({
            argv: argv
        }, function (err, info) {
            t.ifError(err, err);

            var cFound, aFound = false;

            if (!err) {
                var split = info.stdout.split('\n');
                var c = C_UPLOADPATH;
                var a = A_UPLOADPATH;

                split.forEach(function (line) {
                    if (line === c) {
                        cFound = true;
                    } else if (line === a) {
                        aFound = true;
                    }
                });

                t.ok(cFound);
                t.ok(aFound);
            } else {
                console.log(err);
                console.log(info.stderr);
            }

            t.end();
        });
    });


    // Upload a part from a file to the commit object.
    suite.test('mmpu upload C_ID 0 -f tmpFile', function (t) {
        var tmpFile = '/var/tmp/node-manta-mmpu-test-tmp-file-' + process.pid;

        function mkTmpFile(_, cb) {
            fs.writeFile(tmpFile, TEXT, cb);
        }

        function upload(_, cb) {
            var argv = [ MMPU, UPLOAD, C_ID,
                '0',
                '-f', tmpFile
            ];

            forkExecWait({
                argv: argv
            }, function (err, info) {
                if (err) {
                    cb(err);
                } else {
                     C_ETAG0 = info.stdout.replace('\n', '');
                     cb();
                }
            });
        }

        function rmTmpFile(_, cb) {
            fs.unlink(tmpFile, cb);
        }

        vasync.pipeline({
            funcs: [
                mkTmpFile,
                upload,
                rmTmpFile
            ]
        }, function (err, results) {
            t.ifError(err, err);
            t.end();
        });
    });


    // Upload a part from a stream to the abort object.
    suite.test('mmpu upload A_ID 0', function (t) {
        var argv = [ MMPU, UPLOAD, A_ID,
            '0'
        ];

        var child = forkExecWait({
            argv: argv
        }, function (err, info) {
            t.ifError(err, err);
            if (!err) {
                A_ETAG0 = info.stdout.replace('\n', '');
            } else {
                console.log(err);
                console.log(info.stderr);
            }
            t.end();
        });

        setImmediate(function () {
            child.stdin.write(TEXT);
            child.stdin.end();
        });
    });

    // Check that one part has been uploaded for C_ID.
    suite.test('mmpu parts C_ID: post-upload', function (t) {
        var argv = [ MMPU, PARTS, C_ID ];

        forkExecWait({
            argv: argv
        }, function (err, info) {
            t.ifError(err, err);
            if (!err) {
                var expectedStdout = C_UPLOADPATH + '/0\n';
                t.equal(info.stdout, expectedStdout);
            } else {
                console.log(err);
                console.log(info.stderr);
            }

            t.end();
        });
    });

    // Check that one part has been uploaded for A_ID.
    suite.test('mmpu parts A_ID: post-upload', function (t) {
        var argv = [ MMPU, PARTS, A_ID ];

        forkExecWait({
            argv: argv
        }, function (err, info) {
            t.ifError(err, err);
            if (!err) {
                var expectedStdout = A_UPLOADPATH + '/0\n';
                t.equal(info.stdout, expectedStdout);
            } else {
                console.log(err);
                console.log(info.stderr);
            }

            t.end();
        });
    });


    // Check that `mmpu list -p` now includes the parts that have been uploaded.
    suite.test('mmpu list -p', function (t) {
        var argv = [ MMPU, LIST, '-p' ];

        forkExecWait({
            argv: argv
        }, function (err, info) {
            t.ifError(err, err);

            var c = C_UPLOADPATH;
            var a = A_UPLOADPATH;
            var c0 = c + '/0';
            var a0 = a + '/0';

            var cFound, aFound, c0Found, a0Found = false;

            if (!err) {
                var split = info.stdout.split('\n');
                split.forEach(function (line) {
                    if (line === c) {
                        cFound = true;
                    } else if (line === a) {
                        aFound = true;
                    } else if (line === c0) {
                        c0Found = true;
                    } else if (line === a0) {
                        a0Found = true;
                    }
                });

                t.ok(cFound);
                t.ok(aFound);
                t.ok(c0Found);
                t.ok(a0Found);
            } else {
                console.log(err);
                console.log(info.stderr);
            }

            t.end();
        });
    });


    // Check that `mmpu list` (without -p) does not show the parts that have
    // been uploaded.
    suite.test('mmpu list: post part upload', function (t) {
        var argv = [ MMPU, LIST ];

        forkExecWait({
            argv: argv
        }, function (err, info) {
            t.ifError(err, err);

            var c = C_UPLOADPATH;
            var a = A_UPLOADPATH;
            var c0 = c + '/0';
            var a0 = a + '/0';

            var cFound, aFound, c0Found, a0Found = false;

            if (!err) {
                var split = info.stdout.split('\n');
                split.forEach(function (line) {
                    if (line === c) {
                        cFound = true;
                    } else if (line === a) {
                        aFound = true;
                    } else if (line === c0) {
                        c0Found = true;
                    } else if (line === a0) {
                        a0Found = true;
                    }
                });

                t.ok(cFound);
                t.ok(aFound);
                t.ok(!c0Found);
                t.ok(!a0Found);
            } else {
                console.log(err);
                console.log(info.stderr);
            }

            t.end();
        });
    });



    // Commit the object, do an mget of it to verify it's the object we expect,
    // and remove it to clean up.
    suite.test('mmpu commit C_ID C_ETAG0', function (t) {
        function commit(_, cb) {
            var argv = [ MMPU, COMMIT, C_ID, C_ETAG0 ];

            forkExecWait({
                argv: argv
            }, function (err, info) {
                if (err) {
                    cb(err);
                } else {
                    cb();
                }
            });
        }

        function checkCommitState(_, cb) {
            var argv = [ MMPU, GET, C_ID ];

            forkExecWait({
                argv: argv
            }, function (err, info) {
                if (err) {
                    cb(err);
                } else {
                    var upload = JSON.parse(info.stdout);
                    t.ok(upload.state, 'done');
                    t.ok(upload.result, 'committed');
                    cb();
                }
            });
        }

        function getCommitObj(_, cb) {
            var argv = [ MGET, C_OBJ_PATH ];

            forkExecWait({
                argv: argv
            }, function (err, info) {
                if (err) {
                    cb(err);
                } else {
                    var output = info.stdout.replace('\n', '');
                    t.equal(TEXT, output);
                    cb();
                }
            });
        }

        function rmCommitObj(_, cb) {
            var argv = [ MRM, C_OBJ_PATH ];

            forkExecWait({
                argv: argv
            }, function (err, info) {
                if (err) {
                    cb(err);
                } else {
                     cb();
                }
            });
        }

        vasync.pipeline({
            funcs: [
                commit,
                checkCommitState,
                getCommitObj,
                rmCommitObj
            ]
        }, function (err, results) {
            t.ifError(err, err);
            t.end();
        });
    });


    // Abort the object being uploaded to A_OBJ_PATH.
    suite.test('mmpu abort A_ID', function (t) {
        function abort(_, cb) {
            var argv = [ MMPU, ABORT, A_ID ];

            forkExecWait({
                argv: argv
            }, function (err, info) {
                if (err) {
                    cb(err);
                } else {
                    cb();
                }
            });
        }

        function checkAbortState(_, cb) {
            var argv = [ MMPU, GET, A_ID ];

            forkExecWait({
                argv: argv
            }, function (err, info) {
                if (err) {
                    cb(err);
                } else {
                    var upload = JSON.parse(info.stdout);
                    t.ok(upload.state, 'done');
                    t.ok(upload.result, 'aborted');
                    cb();
                }
            });
        }

        vasync.pipeline({
            funcs: [
                abort,
                checkAbortState
            ]
        }, function (err, results) {
            t.ifError(err, err);
            t.end();
        });
    });

    suite.end();
});
