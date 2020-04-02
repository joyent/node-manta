# node-manta Changelog

See `CONTRIBUTING.md` for details on how to update this file

## not yet released

## 5.2.2

- [#313](https://github.com/joyent/node-manta/issues/313) mget -H option documented incorrectly
- [#358](https://github.com/joyent/node-manta/issues/358) mchmod command stopped working after v5.1.1
- [#361](https://github.com/joyent/node-manta/issues/361) expires-relative short option has wrong case in man page
- [#349](https://github.com/joyent/node-manta/issues/349) issue numbers in
  CHANGES.md should link to GitHub issues
- [#335](https://github.com/joyent/node-manta/issues/335) Want option to confim
  removal of files for `mrm`
- [#353](https://github.com/joyent/node-manta/issues/353) add "msign -s"
  argument to shorten signed urls using the https://i.no.de service.

  `mrm -I` and `mrmdir -I` now supported
- [#62](https://github.com/joyent/node-manta/issues/62) RFE - mls list with human readable format

  `mls` now supports `-h` for human readable output with `-l`, ie: `mls -lh`.

  **Note:** this means `-h` is no longer an alias for `--help`.

## 5.2.1

- [MANTA-3679](https://smartos.org/bugview/MANTA-3679) content-md5 bugs in
  muskie GetJob and node-manta 'mjob get' lead to BadDigest for non-ascii
  content.

  Fixes a rare bug that can cause a Content-MD5 failure in `mjob get` against a
  Manta webapi using a different version.

## 5.2.0

- [#61](https://github.com/joyent/node-manta/issues/61) msign should allow for
  friendlier expiry date formats

  `msign -E <expires>` now supported, e.g.

      msign -E 30m ~~/stor/bar # 30 minutes from now
      msign -E 1h ~~/stor/foo  # 1 hour from now

- [#333](https://github.com/joyent/node-manta/issues/333) The --role-tag option
  does not work  for mput, muntar, mln, or mmkdir
- [#329](https://github.com/joyent/node-manta/issues/329) Refactor all commands
  to use common option parsing code
- [#343](https://github.com/joyent/node-manta/issues/343) Want `mjob wait` as
  alias for `mjob watch`

## 5.1.1

- [#315](https://github.com/joyent/node-manta/issues/315) document mlogin
  session termination conditions

## 5.1.0

Minor version bump due to a backwards-compatible addition to the multipart
upload client operations. The client operations now allow for a
`partsDirectory` string on the options object for multipart upload methods,
which is used as the URL of the request. Otherwise, the parts directory is
resolved using the server's redirect endpoint.

- [#325](https://github.com/joyent/node-manta/issues/325) ask server for fully
  qualified upload path
- [#326](https://github.com/joyent/node-manta/issues/326) client could support
  accepting fully qualified upload directory as input to MPU operations

## 5.0.0

If you do not check explicitly for `ResourceNotFoundErrors` from multipart
upload operations, this major bump will not affect you. Code that checks for a
`ResourceNotFoundError` in the error cause chain using
[VError](https://github.com/joyent/node-verror)'s `findCauseByName` or
`hasCauseWithName` will continue to work.

Major bump due to a change in the errors that may be returned from client
multipart upload operations. In particular, if Manta returns a
`ResourceNotFoundError` for an MPU operation, it is presumed that the Manta
deployment does not have the multipart upload API enabled. The client will now
return a `FeatureNotSupportedError` from the methods `createUpload`,
`uploadPart`, `abortUpload`, `getUpload`, and `commitUpload` in this case, with
the `ResourceNotFoundError` preserved in the call chain.
Code that specifically checks for the error name `ResourceNotFoundError` to
detect whether multipart upload is supported should be updated appropriately
to use VError.hasCauseWithName.

- [#320](https://github.com/joyent/node-manta/issues/320) client should detect
  if MPU is enabled
- [#319](https://github.com/joyent/node-manta/issues/319) MPU-related tests
  should detect if MPU is supported

## 4.5.0

Minor bump due to a backwards-compatible addition to the `commitUpload` method
on the client. The `commitUpload` method now passes the response from the server
to the callback.

- [#323](https://github.com/joyent/node-manta/issues/323) return response
  argument from client.commitUpload
- [#318](https://github.com/joyent/node-manta/issues/318) node-manta nodejs
  version support
- [#322](https://github.com/joyent/node-manta/issues/322) test7 make target
  should be test8 given node v8
- [#321](https://github.com/joyent/node-manta/issues/321) document mlogin's use
  of poseidon assets

## 4.4.3

- [#244](https://github.com/joyent/node-manta/issues/244) mlogin could disable
  Manta's abort-on-core behavior

## 4.4.2

- [#312](https://github.com/joyent/node-manta/issues/312) Custom header input
  should tolerate ':' characters

## 4.4.1

- [#302](https://github.com/joyent/node-manta/issues/302) Create a manual page
  for `mmpu`
- [#311](https://github.com/joyent/node-manta/issues/311) `createUpload`
  incorrectly handles some target object headers

## 4.4.0

- [#308](https://github.com/joyent/node-manta/issues/308) `mmpu commit` does
  not parse options
- [#309](https://github.com/joyent/node-manta/issues/309) MPU tests are out of
  sync with Muskie master branch implementation

## 4.3.0

- MANTA-2169: Support multipart upload of a single file to Manta

## 4.2.0

Minor bump due to relaxation of API requirements in `mfind` (NotFound
errors are no longer fatal unless none of the arguments are found)

- [#230](https://github.com/joyent/node-manta/issues/230) mlogin resists
  request-level debugging
- [#298](https://github.com/joyent/node-manta/issues/298) mjob-simple fails
  because of GNU date regression
- [#281](https://github.com/joyent/node-manta/issues/281) mfind NotFound errors
  should not be fatal.

## 4.1.1

- [#293](https://github.com/joyent/node-manta/issues/293) ~~ evaluation needs
  to be less pedantic
- [#294](https://github.com/joyent/node-manta/issues/294) content-length and
  transfer-encoding chunked must not be used together

## 4.1.0

- [#214](https://github.com/joyent/node-manta/issues/214) basic bash tab
  completion
- [#288](https://github.com/joyent/node-manta/issues/288) mfind of file blows
  assertion: "ent (object) is required"

## 4.0.0

- [#272](https://github.com/joyent/node-manta/issues/272) `m*` tools should
  have a `--version` option
- [#282](https://github.com/joyent/node-manta/issues/282) mchmod ignores all(?)
  options

  *BREAKING CHANGE* `mchmod` now parses all standard options. The use of the
  `--` form is encouraged to avoid ambiguities in role versus option names (ex:
  `mchmod -- -read,write ~~/stor/foo.txt`).  This is a breaking change for some
  ambiguous invocations of mchmod that worked by accident before. For example
  this:

        mchmod -read,write ~~/stor/foo.txt      # worked before, fails in v4
        mchmod -- -read,write ~~/stor/foo.txt   # works in both major versions

- [#280](https://github.com/joyent/node-manta/issues/280) job expressions do
  not honor --memory

  Ensure that `--disk`, `--memory`, and `--init` options are used with `mjob
  create MAP_PHASE ^ MAP_PHASE ^^ REDUCE_PHASE` style job creation.
- [#279](https://github.com/joyent/node-manta/issues/279) mjob should expressly
  list out allowed sizes for memory

  Improvements to help output for all CLIs.  Also add the `mjob create
  --dry-run ...` option to print the created job object and exit. This is
  useful for exploring and testing `mjob create`s many options.

## 3.1.3

- [#277](https://github.com/joyent/node-manta/issues/277) mjob fails with mjob:
  AssertionError: body (object) is required

## 3.1.2

- [#275](https://github.com/joyent/node-manta/issues/275) msign with subusers
  broken
- [#270](https://github.com/joyent/node-manta/issues/270) Add -p to man mput

## 3.1.1

- [#261](https://github.com/joyent/node-manta/issues/261) "AssertionError:
  undefined (object) is required" after "socket hang up"

## 3.1.0

- [#265](https://github.com/joyent/node-manta/issues/265) `mfind --json,-j`

        $ mfind -j ~~/stor/tmp
        {"name":"foo-file.gz","etag":"142ad91b-73d8-6cb4-9cd9-efacf7df7a9a","size":229535627,"type":"object","mtime":"2014-10-08T22:53:25.146Z","durability":2,"parent":"/trent.mick/stor/tmp","depth":0}
        {"name":"foo.imgmanifest","etag":"88ac47b9-e53f-c065-b446-e2d0455c0c00","size":1052,"type":"object","mtime":"2014-10-08T22:52:44.298Z","durability":2,"parent":"/trent.mick/stor/tmp","depth":0}

## 3.0.0

- [#246](https://github.com/joyent/node-manta/issues/246) Update dependencies
  for a Node v6 age.
  This involved dropping support for node 0.8. It is for this reason, and
  prudence at the large number of dependency updates (many of them across
  major version bumps) that we are doing a major version bump of this package.
  For node >=0.10 users there aren't any *known* backwards incompatibilities.
- MANTA-2937: mchmod client-side workaround for MANTA-2929 InvalidUpdateError

## 2.0.7

- [#252](https://github.com/joyent/node-manta/issues/252) 2.0.6 breaks msign
  with ssh-agent and RSA keys

## 2.0.6

- [#250](https://github.com/joyent/node-manta/issues/250) msign should let
  smartdc-auth decide what algorithm to use

## 2.0.5

- PUBAPI-1214 update smartdc-auth to sshpk-agent 1.2.1, to fix a number of
  bad-state issues arising when using node-manta under heavy load with the
  ssh-agent

## 2.0.4

- MANTA-2812, PUBAPI-1197 fix up support for custom request signers, and
  handle "null signers" properly (prevent the generation of an Authorization
  header)

## 2.0.3

- Updated smartdc-auth version, eliminates duplicated code from http-signature

## 2.0.2

- Updated smartdc-auth version for repeatable builds.

## 2.0.1

- Updated smartdc-auth version for fixes with ED25519 keys.

## 2.0.0

- Change to use latest node-smartdc-auth for signing and authentication.
  This solves a number of issues around key loading and signing, especially
  with the SSH agent. The loadSSHKey method is known to be incompatible,
  but other auth-related API is preserved.

## 1.6.0

- [#237](https://github.com/joyent/node-manta/issues/237) add
  createListStream() API for streaming ls()
- [#238](https://github.com/joyent/node-manta/issues/238) mls --type/-t option
  does not work

## 1.5.2

- [#228](https://github.com/joyent/node-manta/issues/228) pipeline callback
  invoked after the pipeline has already completed

## 1.5.1

- [#218](https://github.com/joyent/node-manta/issues/218) allow custom
  ssh-agent options to be passed to constructor

## 1.5.0

- [#219](https://github.com/joyent/node-manta/issues/219) msign doesn't work on
  paths with # in them
- [#220](https://github.com/joyent/node-manta/issues/220) signURL must
  URI-encode the Manta path

## 1.4.7

- [#216](https://github.com/joyent/node-manta/issues/216) commands fail on
  1.4.6 when using ssh-agent
- [#215](https://github.com/joyent/node-manta/issues/215)
  client.createReadStream should emit an 'open' event like fs.createReadStream
- [#208](https://github.com/joyent/node-manta/issues/208) mget fails for large
  files over slow internet

## 1.4.6

- [#210](https://github.com/joyent/node-manta/issues/210) use path.posix when
  dealing with manta paths
- [#206](https://github.com/joyent/node-manta/issues/206) mget/mput: draw
  progress bar to /dev/tty with `--progress`
- [#200](https://github.com/joyent/node-manta/issues/200) combining implicit
  phases with -m/-r flags drops phases

## 1.4.5

- [#203](https://github.com/joyent/node-manta/issues/203) --account/-a doesn't
  work

## 1.4.4

- MANTA-2436 fix mjob and mfind using account/user options wrong

## 1.4.3

- MANTA-2414 fix CLI tools unable to auth as subuser
- fix presigned URLs for subusers

## 1.4.2

- [#201](https://github.com/joyent/node-manta/issues/201) mget does not respect
  destination backpressure

## 1.4.1

- MANTA-2401 fixed a few missed cases of old RBAC environment variable handling

## 1.4.0

- DOC-590 Use ~~ in man pages instead of MANTA_USER
- DOC-592 Update doc to use MANTA_USER and MANTA_SUBUSER
- MANTA-2401 Switch to "user" and "subuser" instead of "account" and "user"

## 1.3.1

- [#197](https://github.com/joyent/node-manta/issues/197) mjob create -s
  ~~/stor//foo broken in 1.3.0

## 1.3.0

- RBAC Support
    * add --role and --role-tag options
    * add support for authentication as user (MANTA_ACCOUNT, MANTA_USER)

## v1.2.8

- [#187](https://github.com/joyent/node-manta/issues/187) mlogin should support
  session control escape character
- [#188](https://github.com/joyent/node-manta/issues/188) mjob help and
  documentation nits
- [#191](https://github.com/joyent/node-manta/issues/191) signURL is not well
  documented
- [#194](https://github.com/joyent/node-manta/issues/194) mjob create -o emits
  "socket hang up"

## v1.2.7

- include restify v2.8.0
- [#184](https://github.com/joyent/node-manta/issues/184) update progbar to
  0.1.0
- [#181](https://github.com/joyent/node-manta/issues/181) `client.get()` should
  retry/resume downloads when disconnected
- [#180](https://github.com/joyent/node-manta/issues/180) Make invalid key more
  clear
- [#179](https://github.com/joyent/node-manta/issues/179) mlogin(1) should
  allow image selection
- [#177](https://github.com/joyent/node-manta/issues/177) `mls: TypeError:
  Arguments to path.join must be strings` if "HOME" isn't set
- [#156](https://github.com/joyent/node-manta/issues/156) mjob list with spaces
  in name causes "mjob: error: undefined"
- [#167](https://github.com/joyent/node-manta/issues/167) can't upload a zero
  byte file stream without setting content-length
- [#168](https://github.com/joyent/node-manta/issues/168) mls -l gives wrong
  timestamp

## v1.2.6

- [#161](https://github.com/joyent/node-manta/issues/161) Add headers to mget,
  as well as an minfo (HEAD) tool
- [#164](https://github.com/joyent/node-manta/issues/164) mjob/mlogin "-s"
  should not url-encode asset paths

## v1.2.5

- [#149](https://github.com/joyent/node-manta/issues/149) mput -f fails on
  empty file
- mls spewing a random mls: [object Object] at end of listings

## v1.2.4

- `client.mkdir` broke contract of returning an HTTP respose object.

## v1.2.3

- `client.mkdir` should return the same object as `client.info`
- add `path` API to manta client
- [#157](https://github.com/joyent/node-manta/issues/157) mput -p handles
  spaces incorrectly
- depend on restify from npm, not git

## v1.2.2

- ARGH! rollback to node-uuid

## v1.2.1

- libuuid was broken on linux

## v1.2.0

- [#147](https://github.com/joyent/node-manta/issues/147) msign: broken on urls
  with spaces
- [#140](https://github.com/joyent/node-manta/issues/140) sshAgentSigner not
  caching well enough
- [#138](https://github.com/joyent/node-manta/issues/138) mjob/mlogin should
  support `~~` for assets.
- [#132](https://github.com/joyent/node-manta/issues/132) mput should handle
  files that are concurrently being appended to
- [#131](https://github.com/joyent/node-manta/issues/131) add mjob cost
- [#130](https://github.com/joyent/node-manta/issues/130) mput should
  optionally calculate and send content-md5
- [#128](https://github.com/joyent/node-manta/issues/128) want default
  content-type header env var
- [#117](https://github.com/joyent/node-manta/issues/117) mfind add mindepth
  and maxdepth options
- [#106](https://github.com/joyent/node-manta/issues/106) Add possibility for
  recursive listing in MantaClient#ls()
- [#103](https://github.com/joyent/node-manta/issues/103) mls should have an
  option to print out all headers
- [#86](https://github.com/joyent/node-manta/issues/86) feature req: allow put
  API to create missing folders automatically
- [#59](https://github.com/joyent/node-manta/issues/59) would like mls -j to
  include durability and mtime

## v1.1.2

- version bump of "carrier" (pgte/carrier#17)
- "mjob share" style improvements and bug fixes

## v1.1.1

- [#122](https://github.com/joyent/node-manta/issues/122) "mjob share" fails
  when optional readme not specified
- [#114](https://github.com/joyent/node-manta/issues/114) auth: sshAgentSigner
  now works

## v1.1.0

- [#119](https://github.com/joyent/node-manta/issues/119) want "mjob share"
  subcommand
- [#109](https://github.com/joyent/node-manta/issues/109) mlogin(1) should
  print diagnostics on a failed or retried job
- [#108](https://github.com/joyent/node-manta/issues/108) mlogin(1) should
  validate input object before creating job
- [#110](https://github.com/joyent/node-manta/issues/110) muntar should retry
  files on a 500
- [#101](https://github.com/joyent/node-manta/issues/101) MantaClient#put api
  suggestion
- [#96](https://github.com/joyent/node-manta/issues/96) mls behavior isn't
  consistent as we descent a 'directory' tree from the manta 'root'
- [#98](https://github.com/joyent/node-manta/issues/98) mls silently fails if
  you don't have an rsa public key
- [#97](https://github.com/joyent/node-manta/issues/97) mlogin(1) and msign(1)
  broken with trailing slash in MANTA_URL
- [#95](https://github.com/joyent/node-manta/issues/95) mlogin(1) should
  support --init
- [#67](https://github.com/joyent/node-manta/issues/67) "mjob create" should
  notify when input stream left open
- [#32](https://github.com/joyent/node-manta/issues/32) obscure errors for
  invalid Manta URL from `mls` and `mput`
- [#70](https://github.com/joyent/node-manta/issues/70) msign(1) with query
  string is more like msigh
- [#81](https://github.com/joyent/node-manta/issues/81) msign(1) should
  URI-encode before signing
- [#74](https://github.com/joyent/node-manta/issues/74) the --limit (or -l )
  switch for "mfind" does nothing
- [#93](https://github.com/joyent/node-manta/issues/93) CLI commands should
  support `~~/(stor|public|...)`
- [#91](https://github.com/joyent/node-manta/issues/91) "mrm -r" should work on
  an object
- [#92](https://github.com/joyent/node-manta/issues/92) `getPath` should assert
  that the thing being passed in is actually a path
- documentation fixes

## v1.0.1

- MANTA-1617: mlogin: broken with xargs
- [#78](https://github.com/joyent/node-manta/issues/78) mput should not retry
  on PreconditionFailedError (HTTP 412)
- MANTA-1611: support PUT requests from browsers
-- add helper signURL function to client
-- tack properties on sshAgentSigner
-- OpenSSL wants all algorithms in uppercase
- MANTA-1593: client needs to URL encode all URLs sanely
-- [#79](https://github.com/joyent/node-manta/issues/79) mmkdir -p erroneously
  encodes directory names twice
-- [#80](https://github.com/joyent/node-manta/issues/80) "mrm -r" double-encodes
  object names
- [#72](https://github.com/joyent/node-manta/issues/72)
  {options:{headers:{'content-length':undefined}} to client.put causes socket
  errors
- documentation fixes

## v1.0.0

- Initial release
