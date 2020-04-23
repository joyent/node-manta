/*
 * Copyright 2019 Joyent, Inc.
 */

var EventEmitter = require('events').EventEmitter;
var crypto = require('crypto');
var path = require('path-platform');
var util = require('util');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var clone = require('clone');
var jsprim = require('jsprim');
var libuuid = require('uuid');
var LineStream = require('lstream');
var LOMStream = require('lomstream').LOMStream;
var PassThrough = require('stream').PassThrough;
if (!PassThrough)
    PassThrough = require('readable-stream/passthrough.js');
var mime = require('mime');
var once = require('once');
var restifyClients = require('restify-clients');
var vasync = require('vasync');
var Verror = require('verror');
var Watershed = require('watershed').Watershed;

var auth = require('smartdc-auth');
var jobshare = require('./jobshare');
var Queue = require('./queue');
var trackmarker = require('./trackmarker');
var StreamingJSONStream = require('./streaming_json_stream');



///--- Globals

var sprintf = util.format;

mime.default_type = process.env.MANTA_DEFAULT_CONTENT_TYPE ?
    process.env.MANTA_DEFAULT_CONTENT_TYPE : 'application/octet-stream';

/* JSSTYLED */
var ROOT_RE = /^\/([a-zA-Z][a-zA-Z0-9_\.@]+)$/;
var JOBS_STOR_RE = /^\/([a-zA-Z][a-zA-Z0-9_\.@]+)\/jobs/;
var PUBLIC_STOR_RE = /^\/([a-zA-Z][a-zA-Z0-9_\.@]+)\/public/;
var REPORTS_STOR_RE = /^\/([a-zA-Z][a-zA-Z0-9_\.@]+)\/reports/;
var STOR_RE = /^\/([a-zA-Z][a-zA-Z0-9_\.@]+)\/stor/;
var TOKENS_RE = /^\/([a-zA-Z][a-zA-Z0-9_\.@]+)\/tokens/;

var MAX_INT = Math.pow(2, 32) - 1;

// Possible operations on a multipart upload
var UPLOAD_OPS = {
    CREATE: 'create',
    UPLOAD: 'upload',
    COMMIT: 'commit',
    ABORT: 'abort',
    GET: 'state',
    DETECT_MPU: 'detectMpu'
};

function FeatureNotSupportedError(cause, feature) {
    assert.object(cause, 'cause');
    assert.string(feature, 'feature');

    Verror.WError.call(this, {
        name: 'FeatureNotSupportedError',
        cause: cause
    }, '%s is not supported for this Manta deployment', feature);
}
util.inherits(FeatureNotSupportedError, Verror.WError);


///--- Hacks

LineStream.prototype._abandon = function _abandon() {
    this.removeAllListeners('data');
    this.removeAllListeners('end');
    this.removeAllListeners('error');
    this.resume();
};



///--- Errors

function ChecksumError(actual, expected) {
    Error.call(this);

    this.name = 'ChecksumError';
    this.message = sprintf('content-md5 expected to be %s, but was %s',
                           expected, actual);
    Error.captureStackTrace(this, ChecksumError);
}
util.inherits(ChecksumError, Error);


function DownloadError(actual, expected) {
    Error.call(this);

    this.name = 'DownloadError';
    this.message = sprintf('length expected to be %d bytes, %d bytes received',
                           expected, actual);
    Error.captureStackTrace(this, DownloadError);
}
util.inherits(DownloadError, Error);


function InvalidDirectoryError(dir, ent) {
    Error.call(this);

    assert.string(dir, 'dir');
    assert.optionalObject(ent, 'ent');

    this.name = 'InvalidDirectoryError';
    this.message = dir + ' is an invalid manta directory';
    this.info = ent;
    Error.captureStackTrace(this, InvalidDirectoryError);
}
util.inherits(InvalidDirectoryError, Error);


function InvalidPathError(p) {
    Error.call(this);

    this.name = 'InvalidPathError';
    this.message = p + ' is not a valid Manta path';
    Error.captureStackTrace(this, InvalidPathError);
}
util.inherits(InvalidPathError, Error);


function StreamFailedError(p) {
    Error.call(this);

    this.name = 'StreamFailedError';
    this.message = 'stream failed for ' + p;
    Error.captureStackTrace(this, StreamFailedError);
}
util.inherits(StreamFailedError, Error);



///--- Helpers

function cloneJob(job) {
    if (typeof (job) === 'string') {
        return ({phases: [{exec: job}]});
    } else if (Array.isArray(job)) {
        return ({
            phases: job.map(function (j) {
                if (typeof (j) === 'object') {
                    return (j);
                } else if (typeof (j) === 'string') {
                    return ({
                        exec: j
                    });
                } else {
                    throw new TypeError(util.inspect(j) +
                                        ' invalid');
                }
            })
        });
    } else if (typeof (job) === 'object') {
        return (clone(job));
    } else {
        throw new TypeError('job (object) required');
    }
}

/**
 * HTTP Header names are case insensitive, so we ensure
 * that those passed to us are in lower case.
 */
function normalizeHeaders(headers) {
    var tmp = {};

    Object.keys(headers || {}).forEach(function (k) {
        tmp[k.toLowerCase()] = headers[k];
    });

    return (tmp);
}


function createOptions(opts, userOpts) {
    assert.object(opts, 'options');
    assert.string(opts.path, 'options.path');
    assert.object(userOpts, 'userOptions');

    var id = opts.req_id || libuuid.v4();
    var options = {
        headers: normalizeHeaders(userOpts.headers),
        id: id,
        path: opts.path.replace(/\/$/, ''),
        query: clone(userOpts.query || {})
    };

    if (userOpts.role)
        options.headers['role'] = userOpts.role.join(',');

    options.headers.accept = options.headers.accept || opts.accept || '*/*';

    if (options.headers['content-length'] !== undefined ||
        opts.contentLength !== undefined) {
        options.headers['content-length'] =
            options.headers['content-length'] ||
            opts.contentLength;
    }

    if (options.headers['content-md5'] || opts.contentMD5) {
        options.headers['content-md5'] =
            options.headers['content-md5'] ||
            opts.contentMD5;
    }

    if (options.headers['content-type'] || opts.contentType) {
        options.headers['content-type'] =
            options.headers['content-type'] ||
            opts.contentType;
    }

    if (options.headers.expect || opts.expect) {
        options.headers.expect = options.headers.expect || opts.expect;
    }

    if (options.headers.location || opts.location) {
        options.headers.location =
            options.headers.location ||
            opts.location;
    }

    options.headers['x-request-id'] = options.headers['x-request-id'] || id;

    var tmp = {};
    Object.keys(options.headers).forEach(function (k) {
        if (options.headers[k] !== undefined)
            tmp[k] = options.headers[k];
    });
    options.headers = tmp;

    if (opts.limit)
        options.query.limit = options.query.limit || opts.limit;

    if (opts.marker)
        options.query.marker = options.query.marker || opts.marker;

    if (opts.dir || opts.directory) {
        options.query.dir = options.query.dir || opts.dir ||
            opts.query.directory || opts.directory;
    }

    if (opts.obj || opts.object) {
        options.query.obj = options.query.obj || opts.obj ||
            opts.query.object || opts.object;
    }

    if (opts.type) {
        switch (opts.type) {
        case 'o':
        case 'object':
            options.type = 'object';
            options.query.obj = true;
            break;
        case 'd':
        case 'directory':
            options.type = 'directory';
            options.query.dir = true;
            break;
        default:
            throw (new Error('invalid "type": "' + opts.type + '"'));
        }
    }

    return (options);
}


function createRestifyClient(opts, type) {
    var client = restifyClients.createClient({
        agent: opts.agent,
        ca: opts.ca,
        ciphers: opts.ciphers,
        connectTimeout: opts.connectTimeout,
        headers: opts.headers,
        log: opts.log,
        pooling: opts.pooling,
        rejectUnauthorized: opts.rejectUnauthorized,
        retry: opts.retry,
        type: type,
        url: opts.url,
        socketPath: opts.socketPath,
        version: '~1.0'
    });

    return (client);
}



function getPath(p, user, skipEncode) {
    if (typeof (user) === 'boolean') {
        skipEncode = user;
        user = null;
    }

    if (p === '~~') {
        p = '/' + (user || process.env.MANTA_USER);
    } else if (/^~~\//.test(p)) {
        p = p.replace(/^~~\//, '/' + (user || process.env.MANTA_USER) + '/');
    }

    var p2 = path.posix.normalize(p).replace(/\/$/, '');
    if (!skipEncode && !process.env.MANTA_SKIP_URLENCODE)
        p2 = p2.split('/').map(encodeURIComponent).join('/');

    /* JSSTYLED */
    if (!/^\/.*/.test(p2))
        throw new InvalidPathError(p);

    return (p2);
}

function isPath(p, user, skipEncode) {
    if (typeof (user) === 'boolean') {
        skipEncode = user;
        user = null;
    }

    /* JSSTYLED */
    p = p.replace(/^~~\/*/, '/' + (user || process.env.MANTA_USER) + '/');

    var p2 = path.posix.normalize(p).replace(/\/$/, '');
    if (!skipEncode && !process.env.MANTA_SKIP_URLENCODE)
        p2 = p2.split('/').map(encodeURIComponent).join('/');

    /* JSSTYLED */
    return (/^\/.*/.test(p2));
}


function getJobPath(p, user) {
    if (user && !/^\/.*\/jobs/.test(p))
        p = '/' + user + '/jobs/' + p;

    return (path.posix.normalize(p).replace(/\/$/, ''));
}


function onRequestCallback(opts) {
    function onRequest(err, req) {
        if (err) {
            opts.log.debug(err, '%s: error', opts.name);
            opts.cb(err);
        } else {
            req.once('result', opts.onResult);
            if (opts.reqCb) {
                opts.reqCb(req);
            }
        }
    }

    return (onRequest);
}


function onResultCallback(opts) {
    function onResult(err, res) {
        if (err) {
            readError(err, res, function onReadDone() {
                opts.log.debug(err, '%s: error', opts.name);
                opts.cb(err, res);
            });
        } else {
            res.once('end', function onEnd() {
                opts.log.debug('%s: done', opts.name);
                opts.cb(null, res);
            });
            res.resume();
        }
    }

    return (onResult);
}


function onResultLineStreamCallback(opts) {
    var emitter = opts.emitter;
    var log = opts.log;
    var name = opts.name;

    function onResult(err, res) {
        if (err) {
            readError(err, res, function () {
                log.debug(err, '%s: error', name);
                emitter.emit('error', err, res);
            });
            return;
        }

        emitter.emit('result', res);

        var lstream = new LineStream({
            encoding: 'utf8'
        });

        lstream.on('data', function onLine(data) {
            if (data) {
                log.debug({line: data}, '%s: line received', name);
                opts.emitCb(res, data);
            }
        });

        lstream.once('end', function onStreamEnd() {
            log.debug('%s: done', name);
            emitter.emit('end', res);
        });

        res.pipe(lstream);
    }

    return (onResult);
}


function readError(err, res, cb) {
    assert.object(err);
    assert.optionalObject(res);
    assert.func(cb);

    if (res === null)
        return (cb(null, err, res));

    var body = '';
    res.setEncoding('utf8');
    res.on('data', function (chunk) {
        body += chunk;
    });

    res.once('end', function () {
        err._body = body;

        try {
            err.body = JSON.parse(body);
        } catch (e) {
        }

        err.body = err.body || {};
        err.code = err.body.code;
        err.message = err.body.message;
        err.name = err.body.code || err.name;
        if (!/.*Error$/.test(err.name))
            err.name += 'Error';

        cb(null, err, res);
    });

    return (undefined);
}


function resultToInfoCb(_path, cb) {
    return (function resultToInfo(err, res) {
        if (err) {
            readError(err, res, function () {
                cb(err, res);
            });
            return;
        }

        res.once('end', function onEnd() {
            var headers = res.headers;

            if (res.headers['content-type']) {
                var type = mime.extension(res.headers['content-type']);
                if (!type) {
                    /* JSSTYLED */
                    var ct = res.headers['content-type'].split(/\s*;\s*/);
                    if (ct && ct.length >= 2) {
                        type = ct[1].split('=')[1];
                    } else {
                        type = 'bin';
                    }
                }
            }

            var _info = {
                name: path.basename(_path),
                extension: type,
                type: res.headers['content-type']
            };

            try {
                var _n = _info.name
                    .split('/')
                    .map(decodeURIComponent)
                    .join('/');
                _info.name = _n;
            } catch (e) {}

            if (headers.etag)
                _info.etag = headers.etag;
            if (headers['content-md5'])
                _info.md5 = headers['content-md5'];
            if (headers['content-length'])
                _info.size = parseInt(headers['content-length'], 10);
            _info.headers = headers;

            cb(null, res, _info);
        });

        res.resume();
    });
}



///--- API


/**
 * Constructor, but you don't use this directly. use createClient({...});
 * instead which wraps this, and will fill in defaults for you.
 *
 * Parameters (nested under options):
 *  - connectTimeout: 0 to disable (default), or number of ms to wait
 *  - headers: optional object block of headers to always send
 *  - log: bunyan logger instance (this toolkit logs at debug)
 *  - sign: callback function to use for signing (authenticated requests)
 *  - url or socketPath: url of manta
 *  - user : optional user to create jobs under
 *  - subuser: optional subuser under the user
 *  - role: optional array of roles that are active for requests
 *
 * Throws TypeError's if you pass bad arguments.
 */
function MantaClient(options) {
    assert.object(options, 'options');
    assert.finite(options.connectTimeout, 'options.connectTimeout');
    assert.optionalObject(options.headers, 'options.headers');
    assert.object(options.log, 'options.log');
    assert.optionalString(options.url, 'options.url');
    assert.optionalString(options.socketPath, 'options.socketPath');
    assert.optionalString(options.user, 'options.user');
    assert.optionalString(options.subuser, 'options.subuser');
    assert.optionalArrayOfString(options.role, 'options.role');
    if (options.sign === null)
        delete (options.sign);
    assert.optionalFunc(options.sign, 'options.sign');
    assert.ok(options.url || options.socketPath,
              'one of options.url or options.socketPath is required');

    EventEmitter.call(this);

    var self = this;
    this.log = options.log.child({component: 'MantaClient'}, true);

    var u = options.url;
    if (u && !/^http/.test(u))
        u = 'https://' + u;

    this.user = options.user;
    this.subuser = options.subuser;

    if (options.role) {
        options.headers = options.headers || {};
        options.headers.role = options.role.join(',');
    }

    // Annoying that this is copy/paste, but we don't want any shared references
    // otherwise state gets stomped
    this.client = createRestifyClient({
        agent: options.agent,
        ca: options.ca,
        ciphers: options.ciphers,
        connectTimeout: options.connectTimeout,
        headers: normalizeHeaders(options.headers),
        log: self.log,
        rejectUnauthorized: options.rejectUnauthorized,
        retry: options.retry,
        type: 'http',
        url: u,
        socketPath: options.socketPath,
        version: '~1.0'
    }, 'http');
    this.jsonClient = createRestifyClient({
        agent: options.agent,
        ca: options.ca,
        ciphers: options.ciphers,
        connectTimeout: options.connectTimeout,
        headers: normalizeHeaders(options.headers),
        log: self.log,
        rejectUnauthorized: options.rejectUnauthorized,
        retry: options.retry,
        type: 'http',
        url: u,
        socketPath: options.socketPath,
        version: '~1.0'
    }, 'json');

    this.sign = options.sign;

    /*
     * Note about null signers:
     *
     * For historical reasons, as well as accepting {sign: undefined}, we also
     * detect and deal with signers of the form
     * sign: function (str, cb) { cb(null, null); }
     *
     * Both of these forms should yield a MantaClient that does not produce any
     * Authorization header in its requests.
     *
     * These null signers as a function have to be detected and treated
     * specially, as http-signature does not cope well with a cb that calls its
     * callback with null, and we don't really want to change its API to deal
     * with a legacy compat issue that's specific to node-manta.
     *
     * We start by ruling out any signer with a .getKey() method --
     * smartdc-auth always adds this to its signers, and they are never null
     * signers.
     */
    if (this.sign !== undefined &&
        this.sign.getKey === undefined) {

        this.signNullProbe = new EventEmitter();
        this.signNullProbe.finished = false;
        this.signNullProbe.started = false;
    }

    // debugging only
    this._url = u || options.socketPath;
    this._version = '~1.0';
}
util.inherits(MantaClient, EventEmitter);


MantaClient.prototype.close = function close() {
    this.client.close();
    this.jsonClient.close();
};


MantaClient.prototype.signRequest = function (opts, cb) {
    assert.object(opts, 'options');
    assert.object(opts.headers, 'options.headers');
    assert.func(cb, 'callback');

    if (!this.sign) {
        cb(null);
        return;
    }

    if (this.signNullProbe && !this.signNullProbe.finished) {
        this.signNullProbe.once('finish',
            this.signRequest.bind(this, opts, cb));

        if (!this.signNullProbe.started) {
            this.signNullProbe.started = true;

            /*
             * To probe for a null signer, we call the function with some
             * arbitrary string and see if it gives us null back.
             *
             * Of course, this means that any signer which _sometimes_ produces
             * null (eg produces null for some strings and not others, or is
             * stateful and produces null just this one time) will be
             * detected, too. Signers are not really meant to look at their
             * payload and shouldn't be stateful, but if they do or are, they
             * must give an error rather than null if they want to reject
             * signing or have some problem.
             */
            var self = this;
            this.sign('foobar', function (err, sig) {
                if (!err && sig === null) {
                    self.sign = null;
                }
                self.signNullProbe.finished = true;
                self.signNullProbe.emit('finish');
            });
        }
        return;
    }

    var rs = auth.requestSigner({
        sign: this.sign,
        mantaSubUser: true
    });

    // Force 'date' header to contain the current datetime in order to prevent
    // signature authorization clock skew.
    opts.headers.date = rs.writeDateHeader();

    rs.sign(function (err, authz) {
        if (err)
            return (cb(err));
        opts.headers.authorization = authz;
        return (cb(null));
    });
};

/**
 *  Cursory .toString() override so you know something about this object.
 */
MantaClient.prototype.toString = function toString() {
    var user = this.subuser ? this.user + '/' + this.subuser : this.user;
    var str = sprintf('[object MantaClient<url=%s, user=%s, version=%s>]',
                      this._url, user || 'null', this._version);
    return (str);
};


///--- Storage API

/**
 * Updates metadata for an object without changing the data. Note you can
 * only update `content-type`, `m-*` headers and CORS headers.
 *
 * Parameters:
 *  - p: path to update
 *  - opts: (optional) object block where you can set headers and metadata
 *  - cb: callback of the form f(err)
 */
MantaClient.prototype.chattr = function chattr(p, opts, cb) {
    assert.string(p, 'path');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var _path = this.path(p);
    var options = createOptions({
        accept: '*/*',
        path: _path
    }, opts);
    var log = this.log.child({
        path: _path,
        req_id: options.id
    }, true);
    var self = this;

    options.path += '?metadata=true';

    /*
     * Ensure that node doesn't set the "Content-Length" header for us.
     *
     * In <https://github.com/nodejs/node/pull/1062> the behaviour of
     * `https.request(...)` et al was changed after node 0.12 to sometimes
     * implicitly set the Content-Length header if it was known and avoid
     * chunked encoding. IIUC this was for perf gains. This caused a conflict
     * with the Manta webapi "PutMetadata" endpoint
     * (https://apidocs.joyent.com/manta/api.html#PutMetadata) which would
     * error with:
     *     InvalidUpdateError: overwrite of "content-length" forbidden ...
     * if Content-Length was passed in. See MANTA-2929/MANTA-2937.
     *
     * An appropriate fix is *server-side*: it should consider Content-Length
     * to be for the PutMetadata request and not metadata to be changed on
     * the Manta object. However a client-side fix is desireable so that
     * 'mchattr' can work with Manta webapis that don't have a fix.
     *
     * We only do this if content-length wasn't specified because it's not
     * legal to specify chunked encoding with content-length. Callers other
     * than test suites wouldn't normally specify a content length for this
     * request.
     */
    if (!options.headers['content-length']) {
        options.headers['transfer-encoding'] = 'chunked';
    }

    log.debug(options, 'chattr: entered');
    self.signRequest({
        headers: options.headers
    }, function onSignRequest(err) {
        if (err) {
            cb(err);
            return;
        }

        self.client.put(options, onRequestCallback({
            cb: cb,
            log: log,
            name: 'chattr',
            onResult: onResultCallback({
                cb: cb,
                log: log,
                name: 'chattr'
            }),
            reqCb: function onRequest(req) {
                req.end();
            }
        }));

        return;
    });
};


/**
 * Fetches an object back from Manta, and gives you a (standard) ReadableStream.
 *
 * Note this API will validate ContentMD5, and so if the downloaded object does
 * not match, the stream will emit an error.
 *
 * Parameters:
 *  - p: string path
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, stream)
 */
MantaClient.prototype.get = function get(p, opts, cb) {
    assert.string(p, 'path');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.func(cb, 'callback');

    var _path = this.path(p);
    var bytes = 0;
    var etag;
    var hash = crypto.createHash('md5');
    var length = false;
    var options = createOptions({
        accept: opts.accept || '*/*',
        path: _path
    }, opts);
    var log = this.log.child({
        path: _path,
        req_id: options.id
    }, true);
    var self = this;
    var stream = new PassThrough();

    cb = once(cb);

    log.debug(options, 'get: entered');

    // We wrap this in a function in case we get disconnected mid-stream,
    // in which case we can resume the download where we left off
    function _get() {
        function onResult(err, res) {
            if (err) {
                readError(err, res, function () {
                    log.debug(err, 'get: error');
                    if (length) {
                        stream.emit('error', err);
                    } else {
                        cb(err, null, res);
                    }
                });
                return;
            }

            if (res.statusCode === 304) {
                log.debug('get: 304, returning null stream');
                // this should never happen, but just in case it does, ensure
                // the stream isn't left dangling
                if (length) {
                    stream.end();
                } else {
                    cb(null, null, res);
                }
                return;
            }

            res.pause();

            cb(null, stream, res);

            if (length === false &&
                res.headers['content-length'] &&
                !options.headers.range) {

                etag = res.headers.etag;
                length = parseInt(res.headers['content-length'], 10);
            }

            res.on('data', function onData(chunk) {
                bytes += chunk.length;
                hash.update(chunk);
            });

            res.once('end', function onEnd() {
                res.removeAllListeners('data');
                if (length !== false) {
                    if (bytes < length && !opts.no_resume) {
                        res.unpipe(stream);
                        _get();
                        return;
                    } else if (bytes !== length) {
                        stream.emit('error', new DownloadError(bytes, length));
                        return;
                    } else {
                        var _md5 = res.headers['content-md5'];
                        var md5 = hash.digest('base64');
                        if (_md5 && md5 !== _md5) {
                            stream.emit('error', new ChecksumError(md5, _md5));
                            return;
                        }
                    }
                }

                log.debug('get: done');
                stream.end();
            });

            res.pipe(stream, {end: false});
            process.nextTick(res.resume.bind(res));
        }

        self.signRequest({
            headers: options.headers
        }, function onSignRequest(err) {
            if (err) {
                cb(err);
                return;
            }

            if (bytes && length && !opts.no_resume) {
                options.headers['if-match'] = etag;
                options.headers.range = 'bytes=' + bytes + '-' + length;
            }

            self.client.get(options, onRequestCallback({
                cb: cb,
                log: log,
                name: 'get',
                onResult: onResult
            }));
        });
    }

    _get();
};


/**
 * Same API as `get`, but idiomatic for node streaming.
 *
 * Parameters:
 *  - p: string path
 *  - opts: (optional) object block where you can set headers, et al.
 */
MantaClient.prototype.createReadStream = function createReadStream(p, opts) {
    assert.string(p, 'path');
    assert.optionalObject(opts, 'options');

    var stream = new PassThrough();

    this.get(p, opts || {}, function (err, readable, res) {
        if (err) {
            stream.emit('error', err, res);
        } else if (readable) {
            stream.emit('open', res);
            readable.on('error', function (err2) {
                stream.emit('error', err2, res);
            });
            readable.once('end', function () {
                process.nextTick(function () {
                    stream.emit('close', res);
                });
            });
            readable.pipe(stream);
        } else {
            stream.emit('close', res);
        }
    });

    return (stream);
};


/**
 * Like ftw(3) - performs a `find` operation.
 *
 * client.ftw('/', function (err, res) {
 *     assert.ifError(err);
 *
 *     res.on('entry', function (obj) {
 *         console.log(obj);
 *     });
 *
 *     res.once('end', function () {
 *         console.log('all done');
 *     });
 * });
 *
 * Parameters:
 *  - p: string path (must be a directory)
 *  - opts: (optional) object block where you can set headers, et al.
 */
MantaClient.prototype.ftw = function ftw(p, opts, cb) {
    assert.string(p, 'path');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    cb = once(cb);

    var _path = this.path(p, true);
    var options = createOptions({
        accept: '*/*',
        path: _path
    }, opts);
    var maxdepth = opts.maxdepth || opts.depth || MAX_INT;
    var mindepth = opts.mindepth || 0;
    var res = new EventEmitter();
    var self = this;

    options._no_dir_check = true;

    function filter(obj) {
        if (obj.depth < mindepth)
            return;
        if (obj.depth > maxdepth)
            return;
        if (opts.name && !opts.name.test(obj.name))
            return;
        if (opts.size && obj.type === 'object' && opts.size > obj.size)
            return;
        if (opts.type && opts.type === 'd' && obj.type !== 'directory')
            return;
        if (opts.type && opts.type === 'o' && obj.type !== 'object')
            return;

        res.emit(obj.type, obj);
        res.emit('entry', obj);
    }

    function run() {
        var barrier = vasync.barrier();
        var q = new Queue({
            limit: opts.parallel || 50,
            worker: function (_opts, _cb) {
                self.ls(_opts.path, options, function (err, ls_res) {
                    if (err) {
                        err.path = _opts.path;
                        _cb(err);
                        return;
                    }

                    ls_res.on('entry', function onEntry(obj) {
                        obj.depth = _opts.depth;
                        if (obj.type === 'directory' &&
                            (obj.depth + 1) < maxdepth) {
                            var name = obj.parent + '/' + obj.name;
                            barrier.start(name);
                            q.push({
                                depth: obj.depth + 1,
                                path: name
                            });
                        }
                        filter(obj);
                    });

                    ls_res.once('end', function () {
                        barrier.done(_opts.path);
                        _cb();
                    });

                    ls_res.on('error', _cb);
                });
            }
        });

        q.once('error', res.emit.bind(res, 'error'));
        q.once('end', res.emit.bind(res, 'end'));
        barrier.once('drain', q.close.bind(q));

        barrier.start(_path);
        q.push({
            depth: 0,
            path: _path
        });
    }

    // First ensure we're looking at a directory
    this.info(p, options, function (info_err, meta) {
        if (info_err) {
            cb(info_err);
        } else if (meta.extension !== 'directory') {
            var err = new InvalidDirectoryError(p);
            err.info = meta;
            err.info.parent = _path;
            cb(err);
        } else {
            setImmediate(run.bind(self));
            cb(null, res);
        }
    });
};


/**
 * Performs a HEAD request on a key in manta, and gives you back a high-level
 * information block of it.
 *
 * For example, on a directory, you'd get this:
 * {
 *   extension: 'directory',
 *   type: 'application/json; type=directory'
 * }
 *
 * Whereas on an object, you'd get (as an example):
 *
 * {
 *   extension: '.txt',
 *   type: 'text/plain',
 *   etag: 123456...,
 *   md5: AA...,
 *   size: 1024
 * }
 *
 * So you probably want to switch on `type`, which is really the content-type.
 *
 * Parameters:
 *  - p: string path
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, info)
 */
MantaClient.prototype.info = function info(p, opts, cb) {
    assert.string(p, 'path');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var _path = this.path(p);
    var options = createOptions({
        accept: 'application/json, */*',
        path: _path
    }, opts);
    var log = this.log.child({
        path: _path,
        req_id: options.id
    }, true);
    var self = this;

    log.debug(options, 'info: entered');
    self.signRequest({
        headers: options.headers
    }, function onSignRequest(err) {
        if (err) {
            cb(err);
            return;
        }

        self.client.head(options, onRequestCallback({
            cb: cb,
            log: log,
            name: 'info',
            onResult: resultToInfoCb(_path, function (err2, res, _info) {
                if (err2) {
                    cb(err2, res);
                } else {
                    cb(null, _info, res);
                }
            })
        }));

        return;
    });
};


/**
 * Creates a `link` in Manta from an existing object to a new name.
 *
 * As explained elsewhere, this is neither a copy nor a "UNIX link". This is
 * really just setting a new name to point at an existing blob of data.
 *
 * Parameters:
 *  - src: path to existing object
 *  - p: string path to create
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err)
 */
MantaClient.prototype.ln = function ln(src, p, opts, cb) {
    assert.string(src, 'source');
    assert.string(p, 'path');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var _path = this.path(p);
    var _src = this.path(src);
    var options = createOptions({
        accept: 'application/json',
        contentType: 'application/json; type=link',
        location: _src,
        path: _path
    }, opts);
    var log = this.log.child({
        path: _path,
        source: _src,
        req_id: options.id
    }, true);
    var self = this;

    log.debug(options, 'ln: entered');
    self.signRequest({
        headers: options.headers
    }, function onSignRequest(err) {
        if (err) {
            cb(err);
            return;
        }

        self.client.put(options, onRequestCallback({
            cb: cb,
            log: log,
            name: 'ln',
            onResult: onResultCallback({
                cb: cb,
                log: log,
                name: 'ln'
            }),
            reqCb: function (req) {
                req.end();
            }
        }));

        return;
    });
};

/**
 * Performs a directory listing.  This API is similar to the legacy `ls()`, but
 * returning a Readable stream with flow control, etc.
 *
 * Note that if you attempt to call this on a non-directory, this call will
 * error out.
 *
 * Parameters:
 *  - dir: path to directory
 *  - options: (optional) object block where you can set headers, et al.
 */
MantaClient.prototype.createListStream = function createListStream(dir,
    options) {

    assert.string(dir, 'directory');
    if (!options) {
        options = {};
    }
    assert.object(options, 'options');

    var cls = {
        cls_aborted: false,
        cls_manta: this,
        cls_options: createOptions({
            accept: 'application/x-json-stream',
            limit: 1000,
            marker: '',
            path: this.path(dir),
            type: options.type
        }, options),
        cls_parent: this.path(dir, true),
        cls_doDirCheck: options._no_dir_check ? false : true,
        cls_log: null,
        cls_track: null
    };
    cls.cls_log = this.log.child({
        path: cls.cls_options.path,
        req_id: cls.cls_options.id
    }, true);

    var marker_func = clsMarker;
    if (options.time || options.mtime) {
        /*
         * Ask the server to sort the result set by "mtime", rather than
         * "name".
         */
        assert.object(cls.cls_options.query);
        cls.cls_options.query.sort = 'mtime';

        cls.cls_track = trackmarker.createTrackMarker('mtime');
        marker_func = clsMarkerMtime;
    } else {
        cls.cls_track = trackmarker.createTrackMarker('name');
    }

    if (options.reverse) {
        assert.object(cls.cls_options.query);
        cls.cls_options.query.sort_order = 'reverse';
    }

    var lom = new LOMStream({
        limit: cls.cls_options.query.limit,
        marker: marker_func,
        fetch: clsFetch,
        fetcharg: cls
    });

    return (lom);
};

/*
 * Helper routines for "createListStream":
 */
function clsMarkerMtime(ent) {
    return (ent.mtime);
}

function clsMarker(ent) {
    return (ent.name);
}

function clsDirCheck(cls, limitObj, datacb, donecb) {
    cls.cls_manta.info(cls.cls_options.path, function (info_err, meta, res) {
        if (info_err) {
            donecb(info_err);
            return;
        }

        if (meta.extension !== 'directory') {
            /*
             * The path was _not_ a directory.  We emit an error, including
             * the object information -- this enables consumers (e.g.
             * "mls") to avoid a second HEAD request.
             */
            var ent = meta || {};
            ent.parent = cls.cls_parent;

            donecb(new InvalidDirectoryError(cls.cls_options.path, ent));
            return;
        }

        clsFetch(cls, limitObj, datacb, donecb);
    });
}

function clsFetch(cls, limitObj, datacb, donecb) {
    /*
     * On our first invocation, we may need to check to see if this path refers
     * to a directory or an object.
     */
    if (cls.cls_doDirCheck) {
        cls.cls_doDirCheck = false;
        clsDirCheck(cls, limitObj, datacb, donecb);
        return;
    }

    /*
     * LOMStream provides the "limit" and "marker" to use for each request:
     */
    cls.cls_options.query.limit = limitObj.limit;
    cls.cls_options.query.marker = limitObj.marker || '';

    cls.cls_manta.signRequest({
        headers: cls.cls_options.headers
    }, function onSignRequest(s_err) {
        if (s_err) {
            donecb(s_err);
            return;
        }

        clsFetchSigned(cls, limitObj, datacb, donecb);
    });
}

function clsFetchSigned(cls, limitObj, datacb, donecb) {
    /*
     * Fetch the next page of directory entries in the sequence:
     */
    cls.cls_manta.get(cls.cls_options.path, cls.cls_options, function (err,
        stream, res) {

        if (err) {
            donecb(err);
            return;
        }

        cls.cls_track.startPage();

        var cbcalled = false;
        var sjs = new StreamingJSONStream();

        var handleError = function (herr) {
            if (cls.cls_aborted) {
                return;
            }
            cls.cls_aborted = true;

            assert.ok(!cbcalled, 'handleError: cb called twice');
            cbcalled = true;

            stream.unpipe(sjs);
            if (res && res.socket && res.socket.destroy) {
                res.socket.destroy();
            }
            donecb(herr);
        };

        sjs.once('error', function (json_err) {
            cls.cls_log.error({
                line: json_err.data,
                err: json_err
            }, 'createListStream: invalid JSON data');

            handleError(json_err);
        });
        stream.once('error', handleError);

        sjs.on('readable', function () {
            if (cls.cls_aborted) {
                return;
            }

            var ent;
            while ((ent = sjs.read()) !== null) {
                /*
                 * Due to the way the "marker" is handled by the server, there
                 * should be at least one record at the top of the second and
                 * subsequent pages that overlaps with records from the
                 * previous page.
                 */
                if (cls.cls_track.skipCheck(ent.name, ent.mtime)) {
                    /*
                     * This record is one that we have already seen, so skip
                     * it.
                     */
                    continue;
                }

                if (cls.cls_options.type) {
                    /*
                     * The user has requested type filtering.  We expect
                     * muskie to send us only results of the correct type,
                     * but just in case we also filter here.
                     */
                    if (cls.cls_options.type !== ent.type) {
                        continue;
                    }
                }

                ent.parent = cls.cls_parent;

                datacb(ent);
            }
        });
        sjs.once('end', function () {
            if (cls.cls_aborted) {
                return;
            }

            assert.ok(cls.cls_track.countTotal() <= limitObj.limit);
            if (cls.cls_track.countSkipped() === limitObj.limit) {
                assert.strictEqual(cls.cls_track.countIncluded(), 0);
                /*
                 * If we see a full page of objects with the same mtime, we
                 * cannot tell if there are any more objects with the same
                 * mtime or not.  All subsequent requests with the same
                 * marker will return the same results as this request, so
                 * we cannot make forward progress.
                 */
                donecb(new Error('saw ' + limitObj.limit + ' objects ' +
                    'with the same marker'));
                return;
            }

            assert.ok(!cbcalled, 'cb called twice');
            cbcalled = true;

            /*
             * If we receive a page of results where the total number of
             * entries is less than the limit we specified, then that page
             * is the last page in the sequence.  The count must include
             * all of the entries we skipped due to marker-based filtering
             * above.
             */
            var complete = (cls.cls_track.countTotal() < limitObj.limit);

            donecb(null, {
                done: complete,
                results: []
            });
        });

        stream.pipe(sjs);
    });
}


/**
 * Performs a directory listing and gives you the result back as an event
 * emitter.  For a ReadableStream with flow control, see `createListStream()`.
 *
 * Note that if you attempt to call this on a non-directory, this call will
 * error out.
 *
 * Once you are listing a directory, the callback will give you an
 * EventEmitter, and you can watch for 'directory' or 'object' events, like so:
 *
 * client.ls('/', function (err, res) {
 *     assert.ifError(err);
 *
 *     res.on('object', function (obj) {
 *         console.log(obj);
 *     });
 *
 *     res.on('directory', function (dir) {
 *         console.log(dir);
 *     });
 *
 *     res.once('end', function () {
 *         console.log('all done');
 *     });
 * });
 *
 * Parameters:
 *  - dir: path to directory
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, emitter)
 */
MantaClient.prototype.ls = function ls(dir, options, cb) {
    assert.string(dir, 'directory');
    if (typeof (options) === 'function') {
        cb = options;
        options = {};
    }
    assert.object(options, 'options');
    assert.func(cb, 'callback');

    cb = once(cb);

    var directory = this.path(dir);
    var emitter = new EventEmitter();
    var opts = createOptions({
        accept: 'application/x-json-stream',
        limit: options.limit || 1024,
        marker: options.marker || '',
        type: options.type,
        path: directory
    }, options);
    var log = this.log.child({
        path: directory,
        req_id: opts.id
    }, true);
    var marker;
    var parent = this.path(dir, true);
    var returned = false;
    var self = this;

    log.debug('ls: entered');

    if (options.mtime || options.time)
        opts.query.sort = 'mtime';

    if (options.reverse)
        opts.query.sort_order = 'reverse';

    function callback(err) {
        if (err) {
            if (!returned) {
                cb(err);
                returned = true;
            } else {
                emitter.emit('error', err);
            }
        } else if (!returned) {
            cb(null, emitter);
            returned = true;
        }
    }

    function next() {
        var s_opts = {
            headers: opts.headers
        };
        self.signRequest(s_opts, function onSignRequest(s_err) {
            if (s_err) {
                callback(s_err);
                return;
            } else if (!returned) {
                callback();
            }

            self.get(dir, opts, function (err, stream, res) {
                if (err) {
                    callback(err);
                    return;
                }

                var count = 0;
                var lstream = new LineStream();

                lstream.once('error', callback);
                stream.once('error', callback);

                lstream.on('data', function onLine(data) {
                    if (!data || !data.toString())
                        return;

                    var l;
                    try {
                        l = JSON.parse(data.toString());
                    } catch (e) {
                        log.error({
                            line: data,
                            err: e
                        }, 'ls: invalid JSON data');

                        lstream.abandon();
                        emitter.emit('error', e);
                    }

                    function emit() {
                        count++;
                        if (opts.type && opts.type !== l.type) {
                            return;
                        }
                        l.parent = parent;
                        emitter.emit(l.type, l);
                        emitter.emit('entry', l);
                    }

                    if (opts.query.sort === 'mtime') {
                        if (l.mtime !== marker) {
                            marker = l.mtime;
                            emit();
                        }
                    } else {
                        if (l.name !== marker) {
                            marker = l.name;
                            emit();
                        }
                    }
                });

                lstream.once('end', function onEnd() {
                    if (count < (opts.query.limit - 1)) {
                        emitter.emit('end', res);
                    } else {
                        opts.query.marker = marker;
                        next();
                    }
                });

                stream.pipe(lstream);
            });
        });
    }

    // First ensure we're looking at a directory
    if (!options._no_dir_check) {
        this.info(dir, function (info_err, meta, res) {
            if (info_err) {
                cb(info_err, res);
            } else if (meta.extension !== 'directory') {
                var ent = meta || {};
                ent.parent = parent;
                cb(new InvalidDirectoryError(directory, ent), res);
            } else {
                next();
            }
        });
    } else {
        next();
    }
};


/**
 * Called mkdir, but really this is putdir, as it will let you call mkdir on an
 * already existing directory.
 *
 * Parameters:
 *  - dir: path to directory
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, res)
 */
MantaClient.prototype.mkdir = function mkdir(dir, opts, cb) {
    assert.string(dir, 'directory');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var directory = this.path(dir);
    var options = createOptions({
        accept: 'application/json',
        contentType: 'application/json; type=directory',
        path: directory
    }, opts);
    var log = this.log.child({
        path: directory,
        req_id: options.id
    }, true);
    var self = this;

    log.debug(options, 'mkdir: entered');
    self.signRequest({
        headers: options.headers
    }, function onSignRequest(err) {
        if (err) {
            cb(err);
            return;
        }

        self.client.put(options, onRequestCallback({
            cb: cb,
            log: log,
            name: 'mkdir',
            onResult: resultToInfoCb(directory, function (err2, res, _info) {
                if (err2) {
                    cb(err2, res);
                } else {
                    _info.extension = 'directory';
                    _info.type = options.headers['content-type'];
                    cb(null, res, _info);
                }
            }),
            reqCb: function (req) {
                req.end();
            }
        }));

        return;
    });
};


/**
 * Good old mkdirp. If any key along the way exists and isn't a directory,
 * this will error out.
 *
 * Parameters:
 *  - dir: path to directory
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err)
 */
MantaClient.prototype.mkdirp = function mkdirp(dir, opts, cb) {
    assert.string(dir, 'directory');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    cb = once(cb);

    var d = this.path(dir, true);
    var dirs, root;
    var id = opts.req_id || libuuid.v4();
    var log = this.log.child({
        path: d,
        req_id: id
    }, true);
    var _opts = {
        headers: opts.headers,
        req_id: id
    };
    var self = this;
    var tasks = [];

    log.debug('mkdirp: entered');

    dirs = d.split('/').slice(1);
    if (dirs.length > 3 && dirs[1] === 'jobs' && dirs[3] === 'stor') {
        root = sprintf('/%s/jobs/%s/stor', dirs[0], dirs[2]);
        dirs = dirs.slice(4);
    } else {
        root = sprintf('/%s/%s', dirs[0], dirs[1]);
        dirs = dirs.slice(2);
    }

    if (dirs.length === 0) {
        process.nextTick(cb);
        return;
    }

    dirs.forEach(function (_d, i) {
        var tmp = dirs.slice(0, i).join('/');
        var _dir =
            path.posix.normalize(sprintf('/%s/%s/%s', root, tmp, _d));

        tasks.push(function _mkdir(_, _cb) {
            self.mkdir(_dir, _opts, _cb);
        });
    });

    var attempts = 0;
    function run() {
        vasync.pipeline({funcs: tasks}, function (err) {
            log.debug(err, 'mkdirp: %s', err ? 'failed' : 'done');
            if (err && err.name === 'ConcurrentRequestError' &&
                ++attempts < 2) {
                log.warn(err, 'concurrent req: retrying once');
                setTimeout(run.bind(this), 250);
                return;
            }

            cb(err || null);
        });
    }

    run();
};


/**
 * Creates or overwrites an (object) key.  You pass it in a ReadableStream (note
 * that stream *must* support pause/resume), and upon receiving a 100-continue
 * from manta, the bytes get blasted up.
 *
 * In this API, you can either pass in an actual 'size' attribute in the options
 * object. If you set that, that is the content-length header for this request.
 * If you don't set that, the request will be "streaming"
 * (transfer-encoding=chunked), in which case your object either needs to fit
 * into the "default" object size (5Gb currently), OR you need to pass in a
 * header of `max-content-length`, which will be the _maximum_ size of
 * your data. Additionally, you can/should pass in an 'md5' attribute,
 * and you can pass a 'type' attribute which is really the
 * content-type.  If you don't pass in 'type', this API will try to
 * guess it based on the name of the object (using the extension).
 *
 * You can pass in a 'copies' attribute, which sets the number
 * of full object copies to make server side (default is 2).
 *
 * Finally, you can pass in a 'mkdirs' option, which if true will cause the
 * client to create any directories that must exist for the PUT to succeed.
 * This works optimistically by attempting the PUT first, then only if it fails
 * with a DirectoryDoesNotExistError does this function use the mkdirp() library
 * function to create the parent directories.  This can fail for all the reasons
 * mkdirp() can fail.
 *
 * Like the other APIs, you can additionally pass in extra headers, etc. in the
 * options object as well.
 *
 * Parameters:
 *  - p: path to object
 *  - input: ReadableStream where we suck bytes from
 *  - opts: see above
 *  - cb: callback of the form f(err)
 */
MantaClient.prototype.put = function put(p, input, opts, cb) {
    assert.string(p, 'path');
    assert.stream(input, 'input');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.optionalFinite(opts.size, 'options.size');
    assert.func(cb, 'callback');

    input.pause();

    var _path = this.path(p);
    var userHeaders = normalizeHeaders(opts.headers);

    var options = createOptions({
        accept: 'application/json',
        contentMD5: opts.md5,
        contentType: (opts.type ||
                      userHeaders['content-type'] ||
                      mime.lookup(_path)),
        contentLength: opts.size,
        expect: '100-continue',
        path: _path
    }, opts);
    var log = this.log.child({
        path: _path,
        req_id: options.id
    }, true);

    if (opts.copies) {
        options.headers['x-durability-level'] =
            parseInt(opts.copies, 10);
    }

    if (options.headers['content-length'] === undefined)
        options.headers['transfer-encoding'] = 'chunked';

    options._original_path = p; // needed for mkdirp case

    log.debug(options, 'put: entered');
    doPut(this, log, options, input, cb, opts.mkdirs);
};


function doPut(self, log, options, input, cb, allowretry) {
    self.signRequest({
        headers: options.headers
    }, function onSignRequest(err) {
        if (err) {
            cb(err);
            return;
        }

        self.client.put(options, onRequestCallback({
            cb: cb,
            log: log,
            name: 'put',
            onResult: onResultCallback({
                cb: function (puterr, res) {
                    if (!puterr) {
                        cb(null, res);
                        return;
                    }

                    if (!allowretry ||
                        puterr.name !== 'DirectoryDoesNotExistError') {
                            cb(puterr, res);
                            return;
                    }

                    log.debug('put with mkdirp: mkdirp');
                    var parent = path.posix.dirname(path.posix.normalize(
                        options._original_path));
                    self.mkdirp(parent, function onMkdirp(mkdirperr) {
                        if (mkdirperr) {
                            log.debug(mkdirperr, 'put with mkdirp: error');
                            cb(mkdirperr);
                            return;
                        }

                        log.debug('put with mkdirp: mkdirp done');
                        doPut(self, log, options, input, cb, false);
                    });
                },
                log: log,
                name: 'put'
            }),
            reqCb: function (req) {
                req.once('continue', function onContinue() {
                    log.debug('put: continue received');
                    if (input.readable) {
                        input.pipe(req);
                        input.resume();
                    } else {
                        req.end();
                    }
                });
            }
        }));
    });
}

/**
 * Similar API to `put`, but idiomatic syntax for node.js.
 *
 * `path` is the Manta key.
 * `options` is an Object with the same defaults as `put`.
 *
 * This API lets you do things like this:
 *
 * fs.createReadStream('./foo').pipe(client.createWriteStream('~~/stor/foo'));
 *
 * Note node's stream semantics don't really line up wth when Manta has
 * durably stored data, so to use this effectively you'd want to listen
 * for the `close` event on the returned stream.  The HTTP Response object is
 * also emitted there.
 *
 * Parameters:
 *  - p: path to object
 *  - opts: see above
 */
MantaClient.prototype.createWriteStream = function createWriteStream(p, opts) {
    assert.string(p, 'path');
    assert.optionalObject(opts, 'options');

    opts = opts || {};

    var self = this;
    var stream = new PassThrough();

    var cb = once(function _cb(err, res) {
        if (err) {
            stream.emit('error', err);
        } else {
            stream.unpipe();
            stream.emit('close', res);
        }
    });

    self.put(p, stream, opts, cb);

    return (stream);
};


/**
 * Deletes a tree of keys from Manta.
 *
 * Parameters:
 *  - p: path to object
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err)
 */
MantaClient.prototype.rmr = function rmr(p, opts, cb) {
    assert.string(p, 'path');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var _done = false;
    var id = opts.req_id || libuuid.v4();
    var _path = this.path(p, true);
    var log = this.log.child({
        path: _path,
        req_id: id
    }, true);
    var _opts = {
        headers: normalizeHeaders(opts.headers),
        req_id: id,
        limit: opts.limit || 1024,
        offset: 0
    };
    var self = this;
    var work = [];

    var parallelism = opts.parallel || 100;
    var outstanding = 0;

    function done(err) {
        if (!_done) {
            log.trace({ path: p, err: err },
                      'rmr: %s', err ? 'error' : 'done');
            _done = true;
            cb(err);
        }
    }

    function reschedule() {
        if (work.length === 0 || outstanding > parallelism)
            return;

        var todo = work.shift();

        outstanding++;

        todo.func.call(self, todo.path, _opts, function (err, res) {

            if (err) {
                done(err);
                return;
            }

            todo.cb(todo, res);
        });
    }

    function rm(_p, parent) {
        work.push({ path: _p, parent: parent, func: self.unlink,
            cb: function (todo) {
                outstanding--;

                if (!todo.parent) {
                    done(undefined);
                    return;
                }

                if (--todo.parent.entries === 0) {
                    /*
                     * We have removed the last entry in our
                     * parent directory, but we can't yet
                     * schedule it to be blown away -- there may
                     * exist more entries that exceeded our limit.
                     * We therefore call into rmdir() to once
                     * again remove the directory; if there's
                     * nothing left, it will schedule it for
                     * unlinking.
                     */
                    rmdir(todo.parent.path, todo.parent.parent);
                } else {
                    reschedule();
                }
            }
        });

        reschedule();
    }

    function rmdir(_p, parent) {
        work.push({ path: _p, parent: parent, func: self.ls,
            cb: function (todo, res) {
                var dir = { path: _p, entries: 1, parent: parent, empty: true };

                res.once('end', function () {
                    outstanding--;

                    if (--dir.entries === 0) {
                        if (dir.empty) {
                            rm(dir.path, dir.parent);
                        } else {
                            rmdir(dir.path, dir.parent);
                            reschedule();
                        }
                    }
                });

                res.once('error', done.bind(self));

                res.on('object', function (ent) {
                    dir.entries++;
                    dir.empty = false;
                    rm(_p + '/' + ent.name, dir);
                });

                res.on('directory', function (ent) {
                    dir.entries++;
                    dir.empty = false;
                    rmdir(_p + '/' + ent.name, dir);
                });
            }
        });

        reschedule();
    }

    rmdir(_path);
};


/**
 * Deletes an object or directory from Manta. If path points to a directory,
 * the directory *must* be empty.
 *
 * Parameters:
 *  - p: path to object
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, res)
 */
MantaClient.prototype.unlink = function unlink(p, opts, cb) {
    assert.string(p, 'path');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.object(opts, 'options');
    assert.func(cb, 'callback');

    var _path = this.path(p);
    var options = createOptions({
        accept: 'application/json',
        contentLength: 0,
        path: _path
    }, opts);
    var log = this.log.child({
        path: _path,
        req_id: options.id
    }, true);
    var self = this;

    log.debug(options, 'unlink: entered');
    self.signRequest({
        headers: options.headers
    }, function onSignRequest(err) {
        if (err) {
            cb(err);
            return;
        }

        self.client.del(options, onRequestCallback({
            cb: cb,
            log: log,
            name: 'unlink',
            onResult: onResultCallback({
                cb: cb,
                log: log,
                name: 'unlink'
            })
        }));

        return;
    });
};


///--- Jobs API

/**
 * Creates a new compute job in Manta.
 *
 * This API is fairly flexible about what it takes, but really the best
 * thing is for callers to just fully spec out the JSON object, like so:
 *
 * {
 *     name: "word count",
 *     phases: [ {
 *         exec: "wc"
 *     }, {
 *         type: "reduce",
 *         exec: "awk '{ l += $1; w += $2; c += $3 } END { print l, w, c }'"
 *     } ]
 * }
 *
 * Alternatively, you can "cheat" for simple jobs and do this:
 *
 * createJob("grep foo", function (err, job) { ... });
 * createJob(["grep foo", "grep bar"], function (err, job) { ... });
 *
 * Note you can't specify a reduce task using the shorthand, so it's really
 * only useful for a distributed grep, and similar things.
 *
 * The callback will return you a string like '/mark/jobs/123-456-7890',
 * pass that in to subsequent client calls (like addJobKey).
 *
 * Parameters:
 *  - j: job configuration
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, jobPath)
 */
MantaClient.prototype.createJob = function createJob(j, opts, cb) {
    var job = cloneJob(j);
    assert.object(job, 'job');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.func(cb, 'callback');
    assert.ok(opts.user || this.user, 'user must be specified');

    var _path = getJobPath('', opts.user || this.user);
    var options = createOptions({
        accept: 'application/json',
        contentType: 'application/json; type=job',
        path: _path
    }, opts);
    var log = this.log.child({
        path: _path,
        req_id: options.id
    }, true);
    var self = this;

    if (!job.name)
        job.name = '';

    log.debug({
        job: job,
        options: options
    }, 'createJob: entered');
    self.signRequest({
        headers: options.headers
    }, function onSignRequest(err) {
        if (err) {
            cb(err);
            return;
        }

        self.jsonClient.post(options, job, function (err2, _, res) {
            if (err2) {
                log.debug(err, 'createJob: failed');
                cb(err2, null, res);
            } else {
                var l = res.headers.location;
                if (self.user)
                    l = l.split(/\/.+\/jobs\//).pop();

                log.debug({job: l}, 'createJob: done');
                cb(null, l, res);
            }
        });

        return;
    });
};


/**
 * Retrieves a job from Manta.
 *
 * Note this is only the high-level job object, not the input or output
 * keys.  You'll get back something like this:
 *
 *  {
 *      "id": "9b367fec-e565-4036-9696-2bf2f578aff6",
 *      "name": "72d7f19",
 *      "state": "done",
 *      "cancelled": false,
 *      "inputDone": true,
 *      "timeCreated": "2012-09-11T19:09:47.010Z",
 *      "timeDone": "2012-09-11T19:09:56.698Z",
 *      "phases": [ {
 *          "exec": "grep foo",
 *          "type": "map"
 *      } ]
 *  }
 *
 * Parameters:
 *  - j: job path
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, job)
 */
MantaClient.prototype.job = function getJob(j, opts, cb) {
    assert.string(j, 'job');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.func(cb, 'callback');

    var _path = getJobPath(j, this.user) + '/live/status';
    var options = createOptions({
        accept: 'application/json',
        path: _path
    }, opts);
    var log = this.log.child({
        path: _path,
        req_id: options.id
    }, true);
    var self = this;

    log.debug({
        job: j,
        options: options
    }, 'getJob: entered');

    self.signRequest({
        headers: options.headers
    }, function onSignRequest(err) {
        if (err) {
            cb(err);
            return;
        }

        self.jsonClient.get(options, function (err2, req, res, obj) {
            if (err2) {
                if (err2.code !== 'ECONNRESET')
                    log.debug(err, 'getJob: failed');
                cb(err2);
            } else {
                log.debug({job: obj}, 'getJob: done');
                cb(null, obj);
            }
        });
    });
};


/**
 * Lists all jobs in Manta.
 *
 * Note this is only the high-level job object, not the input or output
 * keys.  You'll get back something like this:
 *
 *  {
 *      "id": "9b367fec-e565-4036-9696-2bf2f578aff6",
 *      "name": "72d7f19",
 *      "state": "done",
 *      "cancelled": false,
 *      "inputDone": true,
 *      "timeCreated": "2012-09-11T19:09:47.010Z",
 *      "timeDone": "2012-09-11T19:09:56.698Z",
 *      "phases": [ {
 *          "exec": "grep foo",
 *          "type": "map"
 *      } ]
 *  }
 *
 * Parameters:
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, job)
 */
MantaClient.prototype.listJobs = function listJobs(opts, cb) {
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.func(cb, 'callback');

    var _path = getJobPath('', this.user);

    var _query = '';
    if (opts.state)
        _query = '?state=' + encodeURIComponent(opts.state);

    if (opts.name) {
        if (_query) {
            _query += '&';
        } else {
            _query += '?';
        }
        _query += 'name=' + encodeURIComponent(opts.name);
    }

    if (_query)
        _path += _query;


    var emitter = new EventEmitter();
    var options = createOptions({
        accept: 'application/x-json-stream',
        limit: opts.limit || 1024,
        marker: opts.marker || '',
        path: _path
    }, opts);
    var log = this.log.child({
        path: _path,
        req_id: options.id
    }, true);
    var self = this;


    log.debug('listJobs: entered');
    self.signRequest({
        headers: options.headers
    }, function onSignRequest(err) {
        if (err) {
            cb(err);
            return;
        }

        self.client.get(options, onRequestCallback({
            cb: cb,
            log: log,
            name: 'listJobs',
            onResult: onResultLineStreamCallback({
                emitter: emitter,
                emitCb: function (res, line) {
                    var j;

                    try {
                        j = JSON.parse(line);
                    } catch (e) {
                        log.warn({
                            line: line,
                            err: e
                        }, 'ls: invalid JSON data');
                        res.removeAllListeners('data');
                        res.removeAllListeners('end');
                        res.removeAllListeners('error');
                        emitter.emit('error', e);
                    }

                    emitter.emit('job', j);
                },
                log: log,
                name: 'listJobs'
            }),
            reqCb: function () {
                cb(null, emitter);
            }
        }));

        return;
    });
};
MantaClient.prototype.jobs = MantaClient.prototype.listJobs;


/**
 * Submits job key(s) to an existing job in Manta.
 *
 * key can be either a single key or an array of keys.
 *
 * The keys themselves can either be "fully" pathed, like '/mark/stor/foo', or
 * if account was set, and the keys are under the callers account, then short-
 * handed, like so:
 *
 * var client = manta.createClient({ ..., user: 'mark' });
 * var keys = [
 *   'foo',               // mark/stor/foo
 *   '/dave/stor/bar',
 * ];
 * client.addJobKey('123', keys, function (err) { ... });
 *
 * In the options block, in addition to the usual stuff,  you can pass
 * 'end: true' to close input for this job (so you can avoid calling
 * endJob).
 *
 * Parameters:
 *  - j: job path
 *  - k: string key or array of string keys (see above).
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, job)
 */
MantaClient.prototype.addJobKey = function addJobKey(j, k, opts, cb) {
    assert.string(j, 'job');
    if (!Array.isArray(k)) {
        assert.string(k, 'key');
        k = [k];
    } else {
        assert.arrayOfString(k, 'keys');
    }
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.func(cb, 'callback');

    var self = this;
    var _path = getJobPath(j, this.user) + '/live/in';
    var options = createOptions({
        accept: 'application/json',
        contentType: 'text/plain',
        path: _path
    }, opts);
    var keys = k.map(function (key) {
        /* JSSTYLED */
        if (/^\/.*\/stor\/.*/.test(key))
            return (key);
        return (self.path(key, true).replace(/\r?\n$/, ''));
    });
    var log = this.log.child({
        path: _path,
        req_id: options.id
    }, true);

    if (opts.end)
        options.path += '?end=true';

    log.debug({
        job: j,
        keys: keys,
        options: options
    }, 'addJobKey: entered');
    self.signRequest({
        headers: options.headers
    }, function onSignRequest(err) {
        if (err) {
            cb(err);
            return;
        }

        self.client.post(options, onRequestCallback({
            cb: cb,
            log: log,
            name: 'addJobJey',
            onResult: onResultCallback({
                cb: cb,
                log: log,
                name: 'addJobJey'
            }),
            reqCb: function (req) {
                req.end(keys.join('\r\n'));
            }
        }));

        return;
    });
};


/**
 * Cancels a job.
 *
 * Parameters:
 *  - j: job path
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err)
 */
MantaClient.prototype.cancelJob = function cancelJob(j, opts, cb) {
    assert.string(j, 'job');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.func(cb, 'callback');

    var _path = getJobPath(j, this.user) + '/live/cancel';
    var options = createOptions({
        accept: 'application/json',
        contentLength: 0,
        contentType: 'application/json',
        path: _path
    }, opts);
    var log = this.log.child({
        path: _path,
        req_id: options.id
    }, true);
    var self = this;

    log.debug({
        job: j,
        options: options
    }, 'cancelJob: entered');
    self.signRequest({
        headers: options.headers
    }, function onSignRequest(err) {
        if (err) {
            cb(err);
            return;
        }

        self.jsonClient.post(options, function (err2) {
            if (err2) {
                log.debug(err, 'cancelJob: error');
                cb(err2);
            } else {
                log.debug('cancelJob: done');
                cb(null);
            }
        });

        return;
    });
};


/**
 * Closes input for a job.
 *
 * Parameters:
 *  - j: job path
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, job)
 */
MantaClient.prototype.endJob = function endJob(j, opts, cb) {
    assert.string(j, 'job');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.func(cb, 'callback');

    var _path = getJobPath(j, this.user) + '/live/in/end';
    var options = createOptions({
        accept: 'application/json',
        contentLength: 0,
        contentType: 'application/json',
        path: _path
    }, opts);
    var log = this.log.child({
        path: _path,
        req_id: options.id
    }, true);
    var self = this;

    log.debug({
        job: j,
        options: options
    }, 'endJob: entered');
    self.signRequest({
        headers: options.headers
    }, function onSignRequest(err) {
        if (err) {
            cb(err);
            return;
        }

        self.jsonClient.post(options, function (err2) {
            if (err2) {
                log.debug(err, 'endJob: error');
                cb(err2);
            } else {
                log.debug('endJob: done');
                cb(null);
            }
        });

        return;
    });
};


/**
 * Retrieves all (current) input keys for a job, as a stream.
 *
 * client.jobInput('123', function (err, out) {
 *     assert.ifError(err);
 *
 *     out.on('key', function (k) {
 *         console.log(k);
 *     });
 *
 *     res.once('end', function () {
 *         console.log('done');
 *     });
 * });
 *
 * Parameters:
 *  - j: job identifiedr
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, emitter)
 */
MantaClient.prototype.jobInput = function getJobInput(j, opts, cb) {
    assert.string(j, 'job');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.func(cb, 'callback');

    var _path = getJobPath(j, this.user) + '/live/in';
    var emitter = new EventEmitter();
    var options = createOptions({
        accept: 'application/x-json-stream',
        marker: opts.marker || '',
        path: _path
    }, opts);
    var log = this.log.child({
        path: _path,
        req_id: options.id
    }, true);
    var self = this;

    log.debug({
        job: j,
        options: options
    }, 'jobOutput: entered');
    self.signRequest({
        headers: options.headers
    }, function onSignRequest(err) {
        if (err) {
            cb(err);
            return;
        }

        self.client.get(options, onRequestCallback({
            cb: cb,
            log: log,
            name: 'jobInput',
            onResult: onResultLineStreamCallback({
                emitter: emitter,
                emitCb: function (res, line) {
                    line = line.replace(/\r?\n$/, '');
                    emitter.emit('key', line);
                },
                log: log,
                name: 'jobInput'
            }),
            reqCb: function () {
                cb(null, emitter);
            }
        }));

        return;
    });
};


/**
 * Retrieves all (current) output keys for a job, as a stream.
 *
 * client.jobOutput('123', function (err, out) {
 *     assert.ifError(err);
 *
 *     out.on('key', function (k) {
 *         console.log(k);
 *     });
 *
 *     res.once('end', function () {
 *         console.log('done');
 *     });
 * });
 *
 * Parameters:
 *  - j: job identifiedr
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, emitter)
 */
MantaClient.prototype.jobOutput = function getJobOutput(j, opts, cb) {
    assert.string(j, 'job');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.func(cb, 'callback');

    var _path = getJobPath(j, this.user) + '/live/out';
    var emitter = new EventEmitter();
    var options = createOptions({
        accept: 'application/x-json-stream',
        path: _path
    }, opts);
    var log = this.log.child({
        path: _path,
        req_id: options.id
    }, true);
    var self = this;

    log.debug({
        job: j,
        options: options
    }, 'jobOutput: entered');
    self.signRequest({
        headers: options.headers
    }, function onSignRequest(err) {
        if (err) {
            cb(err);
            return;
        }

        self.client.get(options, onRequestCallback({
            cb: cb,
            log: log,
            name: 'jobOutput',
            onResult: onResultLineStreamCallback({
                emitter: emitter,
                emitCb: function (res, line) {
                    line = line.replace(/\r?\n$/, '');
                    emitter.emit('key', line);
                },
                log: log,
                name: 'jobOutput'
            }),
            reqCb: function () {
                cb(null, emitter);
            }
        }));

        return;
    });
};


/**
 * Retrieves all (current) failed input keys for a job, as a stream.
 *
 * client.jobFailures('123', function (err, out) {
 *     assert.ifError(err);
 *
 *     out.on('key', function (k) {
 *         console.log(k);
 *     });
 *
 *     out.once('end', function () {
 *         console.log('done');
 *     });
 * });
 *
 * Parameters:
 *  - j: job identifier
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, emitter)
 */
MantaClient.prototype.jobFailures = function getJobFailures(j, opts, cb) {
    assert.string(j, 'job');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.func(cb, 'callback');

    var _path = getJobPath(j, this.user) + '/live/fail';
    var emitter = new EventEmitter();
    var options = createOptions({
        accept: 'application/x-json-stream',
        path: _path
    }, opts);
    var log = this.log.child({
        path: _path,
        req_id: options.id
    }, true);
    var self = this;

    log.debug({
        job: j,
        options: options
    }, 'jobOutput: entered');
    self.signRequest({
        headers: options.headers
    }, function onSignRequest(err) {
        if (err) {
            cb(err);
            return;
        }

        self.client.get(options, onRequestCallback({
            cb: cb,
            log: log,
            name: 'jobFailures',
            onResult: onResultLineStreamCallback({
                emitter: emitter,
                emitCb: function (res, line) {
                    line = line.replace(/\r?\n$/, '');
                    emitter.emit('key', line);
                },
                log: log,
                name: 'jobFailures'
            }),
            reqCb: function () {
                cb(null, emitter);
            }
        }));

        return;
    });
};


/**
 * Retrieves all (current) errors for a job, as a stream.
 *
 * client.jobErrors('123', function (err, out) {
 *     assert.ifError(err);
 *
 *     out.on('err', function (err) {
 *         console.log(err);
 *     });
 *
 *     out.once('end', function () {
 *         console.log('done');
 *     });
 * });
 *
 * Parameters:
 *  - j: job identifier
 *  - opts: (optional) object block where you can set headers, et al.
 *  - cb: callback of the form f(err, emitter)
 */
MantaClient.prototype.jobErrors = function getJobErrors(j, opts, cb) {
    assert.string(j, 'job');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.func(cb, 'callback');

    var _path = getJobPath(j, this.user) + '/live/err';
    var emitter = new EventEmitter();
    var options = createOptions({
        accept: 'application/x-json-stream',
        path: _path
    }, opts);
    var log = this.log.child({
        path: _path,
        req_id: options.id
    }, true);
    var self = this;

    log.debug({
        job: j,
        options: options
    }, 'jobOutput: entered');
    self.signRequest({
        headers: options.headers
    }, function onSignRequest(err) {
        if (err) {
            cb(err);
            return;
        }

        function onLine(res, line) {
            line = line.replace(/\r?\n$/, '');
            try {
                emitter.emit('err', JSON.parse(line));
            } catch (e) {
                emitter.removeAllListeners('err');
                emitter.removeAllListeners('end');
                emitter.emit('error', e);
            }
        }

        self.client.get(options, onRequestCallback({
            cb: cb,
            log: log,
            name: 'jobErrors',
            onResult: onResultLineStreamCallback({
                emitter: emitter,
                emitCb: onLine,
                log: log,
                name: 'jobErrors'
            }),
            reqCb: function () {
                cb(null, emitter);
            }
        }));

        return;
    });
};

/**
 * Creates a completely standalone share page for a job that shows inputs,
 * outputs, errors, and so on.  This buffers a relatively large but fixed-size
 * amount of job information in memory.
 *
 * client.jobShare('123', function (err, share) {
 *     assert.ifError(err);
 *     console.log(share.html);
 * });
 *
 * Parameters:
 *  - j: job identifier
 *  - opts: (optional) option object
 *    - readme: Markdown contents to be inserted as a "README" into the page
 *    - maxObjects: maximum number of inputs and outputs to download
 *      (default: 50)
 *    - maxBytesPerObject: maximum bytes of each object to download
 *      (default: 10240 bytes)
 *    - maxErrors: maximum number of errors to report
 *      (default: 10 errors)
 *  - cb: callback of the form f(err, share), where "share" has an "html"
 *    property containing the raw HTML output
 */
MantaClient.prototype.jobShare = function doJobShare(j, opts, cb) {
    assert.string(j, 'job');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }
    assert.func(cb, 'callback');
    assert.optionalString(opts.readme, 'opts.readme');
    assert.optionalFinite(opts.maxObjects, 'opts.maxObjects');
    assert.optionalFinite(opts.maxBytesPerObject, 'opts.maxBytesPerObject');
    assert.optionalFinite(opts.maxErrors, 'opts.maxErrors');

    var jobdir = getJobPath(j, this.user);
    jobshare({
        'client': this,
        'jobdir': jobdir,
        'log': this.log.child({ 'share': jobdir }),
        'readme': opts.readme || undefined,
        'maxObjects': opts.maxObjects || 50,
        'maxBytesPerObject': opts.maxBytesPerObject || 10240,
        'maxErrors': opts.maxErrors || 10
    }, cb);
};


/*
 * Creates a time-limited URL that can be shared with others to access Manta
 * paths using this client's credentials.  Here's an example that creates a URL
 * for accessing "/dave/stor/bar" for the next 5 minutes (300 seconds):
 *
 * client.signURL({
 *     path: '/dave/stor/bar',
 *     expires: Math.floor(Date.now() / 1000) + 300
 * }, callback);
 *
 * Parameters:
 * - algorithm: (optional) signing algorithm to use (as a string)
 * - expires: (optional) URL expire time (in seconds since the Unix epoch)
 * - keyId: (optional) ssh key id to use (to override the client's ssh key)
 * - method: (optional) HTTP method that the URL can be used for (default: GET)
 * - path: the Manta path to sign
 * - query: (optional) query parameters to include in the URL (as an object)
 * - sign: (optional) function for signing the URL (to override client's signer)
 * - user: (optional) user (to override client's user)
 */
MantaClient.prototype.signURL = function signURL(opts, cb) {
    assert.object(opts, 'options');
    assert.string(opts.path, 'options.path');
    assert.func(cb, 'callback');

    /*
     * Note: the default value for "expires" below looks like the parameter
     * should be expressed in milliseconds, but it's actually in seconds.  This
     * hasn't been fixed to avoid breaking working programs.
     */
    var self = this;
    var _opts = {
        algorithm: opts.algorithm,
        expires: opts.expires || new Date().getTime() + (300 * 1000),
        host: require('url').parse(self._url).host,
        keyId: opts.keyId || self.sign.keyId || process.env.MANTA_KEY_ID,
        log: opts.log || self.log,
        method: opts.method || ['GET'],
        path: this.path(opts.path, false),
        query: opts.query,
        role: opts.role,
        'role-tag': opts['role-tag'],
        sign: opts.sign || self.sign,
        user: opts.user || self.sign.user || self.user,
        subuser: opts.subuser || self.sign.subuser || self.subuser,
        mantaSubUser: true,
        manta: true
    };

    auth.signUrl.call(this, _opts, once(cb));
};


// DEPRECATED
// Just a proxy
MantaClient.prototype.signUrl = function signUrl() {
    auth.signUrl.apply(this, arguments);
};


MantaClient.prototype.medusaAttach = function medusaAttach(j, opts, cb) {
    var self = this;
    var log = self.log.child({});

    var ws = new Watershed();
    var wskey = ws.generateKey();
    var res, socket, head, shed;

    assert.string(j, 'job');
    if (typeof (opts) === 'function') {
        cb = opts;
        opts = {};
    }

    var _path = '/' + self.user + '/medusa/attach/' + j + '/master';
    var headers = {
        connection: 'upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': wskey
    };
    var options = createOptions({
        headers: headers,
        path: _path
    }, {
        headers: headers
    });
    log.debug({
        job: j,
        headers: headers
    }, 'medusaAttach: entered');

    log.debug({ options: options });

    /*
     * Phase functions:
     */
    var do_sign_request = function (_, next) {
        self.signRequest({
            headers: options.headers
        }, next);
    };

    var do_websocket_get = function (_, next) {
        self.client.get(options, function onRequest(err, req) {
            if (err) {
                next(err);
                return;
            }

            var fired = false;
            req.once('result', function (_err, _res) {
                if (fired)
                        return;
                fired = true;

                /*
                 * We wanted an Upgrade, but didn't get one.
                 * This is an error condition.
                 */
                var outerr;
                if (_err) {
                    outerr = new Error('Server did not ' +
                        'Upgrade: ' + _err.name + ': ' + _err.message);
                } else {
                    outerr = new Error('Server did not ' +
                        'Upgrade (HTTP ' + _res.statusCode + ')');
                }
                next(outerr);
            });
            req.once('upgradeResult', function (_err, _r, _s, _h) {
                if (fired) {
                    if (_s)
                        _s.destroy();
                    return;
                }
                fired = true;

                if (_err) {
                    next(err);
                    return;
                }

                res = _r;
                socket = _s;
                head = _h;

                next();
            });
        });
    };

    var do_websocket_attach = function (_, next) {
        /*
         * Attempt to attach to the websocket stream,
         * and return it to the caller:
         */
        try {
            socket.setNoDelay(true);
            shed = ws.connect(res, socket, head, wskey);
            next();
            return;
        } catch (ex) {
            next(ex);
            return;
        }
    };

    /*
     * Perform phases:
     */
    vasync.pipeline({
        funcs: [
            do_sign_request,
            do_websocket_get,
            do_websocket_attach
        ]
    }, function final(err) {
        if (err) {
            cb(err);
            return;
        }

        cb(null, shed);
    });
};


MantaClient.prototype.path = function _getPath(p, skipEncode) {
    return (getPath(p, this.user, skipEncode));
};



///--- Multipart Uploads API

/*
 * Given an account and multipart upload operation (plus an upload id and a
 * part number, if relevant), this function returns the correct URL to send a
 * multipart upload related request to.
 *
 * Multipart uploads are stored in subdirectories of the "/<account>/uploads"
 * top-level directory.  The exact structure is not a committed interface: it
 * can differ between different Manta deployments and can change over time with
 * server-side configuration changes.  As such, the API allows the consumer to
 * locate the full path to a multipart upload directory simply by knowing the
 * ID of the upload.
 *
 * This function makes a request to the server as if the upload directory was
 * anchored directly at the top level.  The server will respond with a redirect
 * to the full path, which we use to construct the correct path for the
 * nominated multipart upload operation.
 */
MantaClient.prototype._uploadURL = function _uploadURL(uu, done) {
    assert.func(done, 'done');
    assert.object(uu, 'uu');
    assert.string(uu.uu_account, 'uu_account');
    assert.string(uu.uu_op, 'uu_op');
    assert.optionalString(uu.uu_partsDirectory, 'uu_partsDirectory');

    var self = this;

    var baseURL = '/' + uu.uu_account + '/uploads';

    if (uu.uu_op === UPLOAD_OPS.CREATE) {
        /*
         * The create path is simply the top-level uploads directory.
         */
        setImmediate(done, null, baseURL);
        return;
    }

    var finalURL;
    function callDone(location) {
        assert.string(location, 'location');

        switch (uu.uu_op) {
            case UPLOAD_OPS.COMMIT:
                finalURL = location + '/commit';
                break;
            case UPLOAD_OPS.ABORT:
                finalURL = location + '/abort';
                break;
            case UPLOAD_OPS.GET:
                finalURL = location + '/state';
                break;
            case UPLOAD_OPS.UPLOAD:
                assert.number(uu.uu_partNum, 'partNum');
                finalURL = location + '/' + uu.uu_partNum;
                break;
            default:
                throw (new Verror('Invalid operation: %s', uu.uu_op));
        }

        setImmediate(done, null, finalURL);
    }

    /*
     * If the client provided the parts directory, we can short-circuit the
     * redirect here and just provide the URL needed for the desired operation.
     */
    if (uu.uu_partsDirectory) {
        callDone(uu.uu_partsDirectory);
        return;
    }

    /*
     * Manta allows us to make a request to the top-level upload directory as
     * if the multipart upload was anchored there.  The response will be a
     * redirect to the fully-qualified upload directory.
     */
    assert.uuid(uu.uu_id, 'uu_id');
    assert.object(uu.uu_opts, 'uu_opts');
    var idurl = baseURL + '/' + uu.uu_id;
    var options = createOptions({
        path: idurl
    }, uu.uu_opts);

    var log = this.log.child({
        path: idurl,
        req_id: options.id
    }, true);

    log.debug('_uploadURL: entered');

    self.signRequest({ headers: options.headers }, function (serr) {
        if (serr) {
            serr = new Verror(serr, 'signing request');
            log.debug(serr);
            done(serr);
            return;
        }

        self.client.head(options, function (err, req) {
            if (err) {
                err = new Verror(err, 'locating upload');
                log.debug(err);
                done(err);
                return;
            }

            req.on('result', function (rerr, res) {
                if (rerr && rerr.statusCode === 404) {
                    log.debug(rerr);
                    rerr = new FeatureNotSupportedError(rerr,
                        'multipart upload');
                    log.debug(rerr);
                    done(rerr);
                    return;
                }

                if (rerr) {
                    rerr = new Verror(err, 'locating upload');
                    log.debug(rerr);
                    done(rerr);
                    return;
                }

                if (res.statusCode !== 301) {
                    res.resume();

                    rerr = new Verror('locating upload: unexpected status %d',
                        res.statusCode);
                    log.debug(rerr);
                    done(rerr);
                    return;
                }

                callDone(res.headers['location']);
            });
        });
    });
};


/*
 * Creates a multipart upload in Manta.
 *
 * Parameters:
 *  - p: the path the object will be uploaded to on commit
 *  - opts: optional object block
 *  - cb: callback of the form f(err, uploadId)
 *
 *  The following option is required:
 *    - account: the account associated with the upload
 *
 *  Other optional options are:
 *    - size: the size of the object to be uploaded
 *    - copies: the number of copies of the object to save
 *    - md5: calculated md5 sum of the object
 *    - headers: headers to define on the object
 *
 *  Note that if opts.headers conflicts with the values set in
 *  opts.{size,copies,md5}, the values in the headers object will be
 *  ovewritten with the explicitly set options values.
 *
 */
MantaClient.prototype.createUpload = function createUpload(p, opts, cb) {
    assert.string(p, 'path');
    assert.object(opts, 'options');
    assert.string(opts.account, 'opts.account');
    assert.optionalObject(opts.headers, 'opts.headers');
    assert.optionalNumber(opts.copies, 'opts.copies');
    assert.optionalNumber(opts.size, 'opts.size');
    assert.optionalString(opts.md5, 'opts.md5');
    assert.func(cb, 'callback');

    var self = this;

    self._uploadURL({
        uu_op: UPLOAD_OPS.CREATE,
        uu_account: opts.account,
        uu_opts: opts
    }, function (uerr, url) {
        if (uerr) {
            cb(uerr);
            return;
        }

        var objectPath = self.path(p);

        var createOpts = jsprim.deepCopy(opts);
        if (createOpts.headers) {
            /*
             * We don't want headers for the target object to be interpreted as
             * headers on the request, so we don't pass those to
             * createOptions().
             */
            delete createOpts.headers;
        }

        var options = createOptions({
            accept: 'application/json',
            contentType: 'application/json',
            path: url
        }, createOpts);

        var targetObjectHeaders = {};
        if (opts.headers) {
            targetObjectHeaders = jsprim.deepCopy(opts.headers);
        }

        if (opts.copies) {
            targetObjectHeaders['durability-level'] = opts.copies;
        }

        if (opts.size) {
            targetObjectHeaders['content-length'] = opts.size;
        }

        if (opts.md5) {
            targetObjectHeaders['content-md5'] = opts.md5;
        }

        var log = self.log.child({
            path: url,
            req_id: options.id
        }, true);

        log.debug('createUpload: entered');
        self.signRequest({
            headers: options.headers
        }, function onSignRequest(err) {
            if (err) {
                err = new Verror(err, 'signing request');
                log.debug(err);
                cb(err);
                return;
            }

            var body = {
                objectPath: objectPath,
                headers: targetObjectHeaders
            };

            self.jsonClient.post(options, body, function (err2, req, res, obj) {
                if (err2) {
                    log.debug(err2);
                    if (err2.statusCode === 404) {
                        cb(new FeatureNotSupportedError(err2,
                            'multipart upload'));
                    } else {
                        cb(err2);
                    }
                } else {
                    cb(null, obj);
                }
            });

            return;
        });
    });
};


/*
 * Uploads a part to a multipart upload.
 *
 * Parameters:
 *  - stream: stream containing the part data
 *  - id: upload uuid
 *  - partNum: the part number
 *  - opts: options object that must contain the following:
 *      - account: the Manta account the upload belongs to
 *  - cb: callback function of the form f(err, res, req)
 */
MantaClient.prototype.uploadPart =
function uploadPart(stream, id, partNum, opts, cb) {
    assert.stream(stream, 'stream');
    assert.string(id, 'id');
    assert.object(opts, 'opts');
    assert.string(opts.account, 'opts.account');
    assert.optionalString(opts.partsDirectory, 'opts.partsDirectory');
    assert.func(cb, 'callback');

    var self = this;

    self._uploadURL({
        uu_op: UPLOAD_OPS.UPLOAD,
        uu_account: opts.account,
        uu_id: id,
        uu_partNum: partNum,
        uu_partsDirectory: opts.partsDirectory,
        uu_opts: opts
    }, function (uerr, url) {
        if (uerr) {
            cb(uerr);
            return;
        }

        var options = createOptions({
            accept: 'application/json',
            expect: '100-continue',
            path: url
        }, opts);

        var log = self.log.child({
            path: url,
                req_id: options.id
        }, true);

        log.debug('uploadPart: entered');
        self.signRequest({
            headers: options.headers
        }, function onSignRequest(err) {
            if (err) {
                err = new Verror(err, 'signing request');
                log.debug(err);
                cb(err);
                return;
            }

            function reqCb(req) {
                req.once('continue', function onContinue() {
                    log.debug('uploadPart: continue received');
                    if (stream.readable) {
                        stream.pipe(req);
                        stream.resume();
                    } else {
                        req.end();
                    }
                });
            }

            self.client.put(options, onRequestCallback({
                cb: cb,
                log: log,
                name: 'uploadPart',
                onResult: onResultCallback({
                    cb: function onResultCb(err2, res) {
                        if (err2 && err2.statusCode === 404) {
                            cb(new FeatureNotSupportedError(err2,
                                'multipart upload'));
                        } else {
                            cb(err2, res);
                        }
                    },
                    log: log,
                    name: 'uploadPart'
                }),
                reqCb: reqCb
            }));
        });
    });
};


/*
 * Aborts an upload.
 *
 * Parameters:
 *  - id: upload uuid
 *  - opts: options object with the following:
 *      - account: the Manta account the upload belongs to
 *      - partsDirectory: upload directory of the upload (optional)
 *  - cb: callback function of the form f(err)
 */
MantaClient.prototype.abortUpload = function abortUpload(id, opts, cb) {
    assert.string(id, 'id');
    assert.object(opts, 'options');
    assert.string(opts.account, 'opts.account');
    assert.optionalString(opts.partsDirectory, 'opts.partsDirectory');
    assert.func(cb, 'callback');

    var self = this;

    self._uploadURL({
        uu_op: UPLOAD_OPS.ABORT,
        uu_account: opts.account,
        uu_id: id,
        uu_partsDirectory: opts.partsDirectory,
        uu_opts: opts
    }, function (uerr, url) {
        if (uerr) {
            cb(uerr);
            return;
        }

        var options = createOptions({
            path: url
        }, opts);

        var log = self.log.child({
            path: url,
            req_id: options.id
        }, true);

        log.debug('abortUpload: entered');
        self.signRequest({
            headers: options.headers
        }, function onSignRequest(err) {
            if (err) {
                err = new Verror(err, 'signing request');
                log.debug(err);
                cb(err);
                return;
            }

            self.jsonClient.post(options, function (err2, req, res, obj) {
                if (err2) {
                    log.debug(err2);
                    if (err2.statusCode === 404) {
                        cb(new FeatureNotSupportedError(err2,
                            'multipart upload'));
                    } else {
                        cb(err2);
                    }
                } else {
                    cb();
                }
            });
        });
    });
};

/*
 * Gets information about an upload, including its state, the path the
 * object will be uploaded to, headers for the object, and how many
 * copies of it will be stored.
 *
 * Parameters:
 *  - id: upload uuid
 *  - opts: options object with the following:
 *      - account: the Manta account the upload belongs to
 *      - partsDirectory: upload directory of the upload (optional)
 *  - cb: callback function of the form f(err, upload)
 */
MantaClient.prototype.getUpload = function getUpload(id, opts, cb) {
    assert.string(id, 'id');
    assert.object(opts, 'options');
    assert.string(opts.account, 'opts.account');
    assert.optionalString(opts.partsDirectory, 'opts.partsDirectory');
    assert.func(cb, 'callback');

    var self = this;

    self._uploadURL({
        uu_op: UPLOAD_OPS.GET,
        uu_account: opts.account,
        uu_id: id,
        uu_partsDirectory: opts.partsDirectory,
        uu_opts: opts
    }, function (uerr, url) {
        if (uerr) {
            cb(uerr);
            return;
        }

        var options = createOptions({
            path: url
        }, opts);

        var log = self.log.child({
            path: url,
            req_id: options.id
        }, true);

        log.debug('getUpload: entered');
        self.signRequest({
            headers: options.headers
        }, function onSignRequest(err) {
            if (err) {
                err = new Verror(err, 'signing request');
                log.debug(err);
                cb(err);
                return;
            }

            self.jsonClient.get(options, function (err2, req, res, obj) {
                if (err2) {
                    log.debug(err2);
                    if (err2.statusCode === 404) {
                        cb(new FeatureNotSupportedError(err2,
                            'multipart upload'));
                    } else {
                        cb(err2);
                    }
                } else {
                    cb(null, obj);
                }
            });
        });
    });
};


/*
 * Commits an upload.
 *
 * Parameters:
 *  - id: upload uuid
 *  - p: an array of part etags
 *  - opts: options object with the following:
 *      - account: the Manta account the upload belongs to
 *      - partsDirectory: upload directory of the upload (optional)
 *  - cb: callback function of the form f(err)
 */
MantaClient.prototype.commitUpload = function commitUpload(id, p, opts, cb) {
    assert.string(id, 'id');
    assert.object(opts, 'options');
    assert.string(opts.account, 'opts.account');
    assert.optionalString(opts.partsDirectory, 'opts.partsDirectory');
    assert.func(cb, 'callback');

    var self = this;

    self._uploadURL({
        uu_op: UPLOAD_OPS.COMMIT,
        uu_account: opts.account,
        uu_id: id,
        uu_partsDirectory: opts.partsDirectory,
        uu_opts: opts
    }, function (uerr, url) {
        if (uerr) {
            cb(uerr);
            return;
        }

        var options = createOptions({
            accept: 'application/json',
            contentType: 'application/json',
            path: url
        }, opts);

        var log = self.log.child({
            path: url,
            req_id: options.id
        }, true);

        log.debug('commitUpload: entered');
        self.signRequest({
            headers: options.headers
        }, function onSignRequest(err) {
            if (err) {
                err = new Verror(err, 'signing request');
                log.debug(err);
                cb(err);
                return;
            }

            var body = { parts:  p };
            self.jsonClient.post(options, body, function (err2, req, res) {
                if (err2) {
                    log.debug(err2);
                    if (err2.statusCode === 404) {
                        cb(new FeatureNotSupportedError(err2,
                            'multipart upload'));
                    } else {
                        cb(err2);
                    }
                } else {
                    cb(null, res);
                }
            });
        });
    });
};


///--- Exports

module.exports = {
    path: getPath, // useful for the CLI
    isPath: isPath, // useful for the CLI
    jobPath: getJobPath, // useful for mjob
    createOptions: createOptions, // useful for testing
    MantaClient: MantaClient
};
