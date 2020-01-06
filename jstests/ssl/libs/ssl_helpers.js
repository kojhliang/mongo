load('jstests/multiVersion/libs/multi_rs.js');

// Do not fail if this test leaves unterminated processes because this file expects replset1.js to
// throw for invalid SSL options.
TestData.failIfUnterminatedProcesses = false;

//=== Shared SSL testing library functions and constants ===

var KEYFILE = "jstests/libs/key1";
var SERVER_CERT = "jstests/libs/server.pem";
var CA_CERT = "jstests/libs/ca.pem";
var CLIENT_CERT = "jstests/libs/client.pem";
var DH_PARAM = "jstests/libs/8k-prime.dhparam";

// Note: "sslAllowInvalidCertificates" is enabled to avoid
// hostname conflicts with our testing certificates
var disabled = {sslMode: "disabled"};
var allowSSL = {
    sslMode: "allowSSL",
    sslAllowInvalidCertificates: "",
    sslPEMKeyFile: SERVER_CERT,
    sslCAFile: CA_CERT
};
var preferSSL = {
    sslMode: "preferSSL",
    sslAllowInvalidCertificates: "",
    sslPEMKeyFile: SERVER_CERT,
    sslCAFile: CA_CERT
};
var requireSSL = {
    sslMode: "requireSSL",
    sslAllowInvalidCertificates: "",
    sslPEMKeyFile: SERVER_CERT,
    sslCAFile: CA_CERT
};

var dhparamSSL = {
    sslMode: "requireSSL",
    sslAllowInvalidCertificates: "",
    sslPEMKeyFile: SERVER_CERT,
    sslCAFile: CA_CERT,
    setParameter: {"opensslDiffieHellmanParameters": DH_PARAM}
};

// Test if ssl replset  configs work

var replSetTestFile = "jstests/replsets/replset1.js";

var replShouldSucceed = function(name, opt1, opt2) {
    ssl_options1 = opt1;
    ssl_options2 = opt2;
    ssl_name = name;
    // try running this file using the given config
    load(replSetTestFile);
};

// Test if ssl replset configs fail
var replShouldFail = function(name, opt1, opt2) {
    ssl_options1 = opt1;
    ssl_options2 = opt2;
    ssl_name = name;
    assert.throws(load, [replSetTestFile], "This setup should have failed");
    // Note: this leaves running mongod processes.
};

/**
 * Test that $lookup works with a sharded source collection. This is tested because of
 * the connections opened between mongos/shards and between the shards themselves.
 */
function testShardedLookup(shardingTest) {
    var st = shardingTest;
    assert(st.adminCommand({enableSharding: "lookupTest"}),
           "error enabling sharding for this configuration");
    assert(st.adminCommand({shardCollection: "lookupTest.foo", key: {_id: "hashed"}}),
           "error sharding collection for this configuration");

    var lookupdb = st.getDB("lookupTest");

    // insert a few docs to ensure there are documents on multiple shards.
    var fooBulk = lookupdb.foo.initializeUnorderedBulkOp();
    var barBulk = lookupdb.bar.initializeUnorderedBulkOp();
    var lookupShouldReturn = [];
    for (var i = 0; i < 64; i++) {
        fooBulk.insert({_id: i});
        barBulk.insert({_id: i});
        lookupShouldReturn.push({_id: i, bar_docs: [{_id: i}]});
    }
    assert.commandWorked(fooBulk.execute());
    assert.commandWorked(barBulk.execute());

    var docs =
        lookupdb.foo
            .aggregate([
                {$sort: {_id: 1}},
                {$lookup: {from: "bar", localField: "_id", foreignField: "_id", as: "bar_docs"}}
            ])
            .toArray();
    assert.eq(lookupShouldReturn, docs, "error $lookup failed in this configuration");
    assert.commandWorked(lookupdb.dropDatabase());
}

/**
 * Takes in two mongod/mongos configuration options and runs a basic
 * sharding test to see if they can work together...
 */
function mixedShardTest(options1, options2, shouldSucceed) {
    let authSucceeded = false;
    try {
        // Start ShardingTest with enableBalancer because ShardingTest attempts to turn
        // off the balancer otherwise, which it will not be authorized to do if auth is enabled.
        //
        // Also, the autosplitter will be turned on automatically with 'enableBalancer: true'. We
        // then want to disable the autosplitter, but cannot do so here with 'enableAutoSplit:
        // false' because ShardingTest will attempt to call disableAutoSplit(), which it will not be
        // authorized to do if auth is enabled.
        //
        // Once SERVER-14017 is fixed the "enableBalancer" line can be removed.
        // TODO: SERVER-43899 Make sharding_with_x509.js and mixed_mode_sharded_transition.js start
        // shards as replica sets.
        var st = new ShardingTest({
            mongos: [options1],
            config: [options1],
            shards: [options1, options2],
            other: {enableBalancer: true, shardAsReplicaSet: false}
        });

        // Create admin user in case the options include auth
        st.admin.createUser({user: 'admin', pwd: 'pwd', roles: ['root']});
        st.admin.auth('admin', 'pwd');

        authSucceeded = true;

        st.stopBalancer();
        st.disableAutoSplit();

        // Test that $lookup works because it causes outgoing connections to be opened
        testShardedLookup(st);

        // Test mongos talking to config servers
        var r = st.adminCommand({enableSharding: "test"});
        assert.eq(r, true, "error enabling sharding for this configuration");

        st.ensurePrimaryShard("test", st.shard0.shardName);
        r = st.adminCommand({movePrimary: 'test', to: st.shard1.shardName});
        assert.eq(r, true, "error movePrimary failed for this configuration");

        var db1 = st.getDB("test");
        r = st.adminCommand({shardCollection: "test.col", key: {_id: 1}});
        assert.eq(r, true, "error sharding collection for this configuration");

        // Test mongos talking to shards
        var bigstr = Array(1024 * 1024).join("#");

        var bulk = db1.col.initializeUnorderedBulkOp();
        for (var i = 0; i < 128; i++) {
            bulk.insert({_id: i, string: bigstr});
        }
        assert.commandWorked(bulk.execute());
        assert.eq(128, db1.col.count(), "error retrieving documents from cluster");

        // Split chunk to make it small enough to move
        assert.commandWorked(st.splitFind("test.col", {_id: 0}));

        // Test shards talking to each other
        r = st.getDB('test').adminCommand(
            {moveChunk: 'test.col', find: {_id: 0}, to: st.shard0.shardName});
        assert(r.ok, "error moving chunks: " + tojson(r));

        db1.col.remove({});

    } catch (e) {
        if (shouldSucceed)
            throw e;
        // silence error if we should fail...
        print("IMPORTANT! => Test failed when it should have failed...continuing...");
    } finally {
        // Authenticate csrs so ReplSetTest.stopSet() can do db hash check.
        if (authSucceeded && st.configRS) {
            st.configRS.nodes.forEach((node) => {
                node.getDB('admin').auth('admin', 'pwd');
            });
        }
        // This has to be done in order for failure
        // to not prevent future tests from running...
        if (st) {
            st.stop();
        }
    }
}

function determineSSLProvider() {
    'use strict';
    const info = getBuildInfo();
    const ssl = (info.openssl === undefined) ? '' : info.openssl.running;
    if (/OpenSSL/.test(ssl)) {
        return 'openssl';
    } else if (/Apple/.test(ssl)) {
        return 'apple';
    } else if (/Windows/.test(ssl)) {
        return 'windows';
    } else {
        return null;
    }
}

function requireSSLProvider(required, fn) {
    'use strict';
    if ((typeof required) === 'string') {
        required = [required];
    }

    const provider = determineSSLProvider();
    if (!required.includes(provider)) {
        print("*****************************************************");
        print("Skipping " + tojson(required) + " test because SSL provider is " + provider);
        print("*****************************************************");
        return;
    }
    fn();
}

function detectDefaultTLSProtocol() {
    const conn = MongoRunner.runMongod({
        sslMode: 'allowSSL',
        sslPEMKeyFile: SERVER_CERT,
        sslDisabledProtocols: 'none',
        useLogFiles: true,
        tlsLogVersions: "TLS1_0,TLS1_1,TLS1_2,TLS1_3",
        waitForConnect: true,
    });

    assert.eq(0,
              runMongoProgram('mongo',
                              '--ssl',
                              '--port',
                              conn.port,
                              '--sslPEMKeyFile',
                              'jstests/libs/client.pem',
                              '--sslCAFile',
                              'jstests/libs/ca.pem',
                              '--eval',
                              ';'));

    const res = conn.getDB("admin").serverStatus().transportSecurity;

    MongoRunner.stopMongod(conn);

    // Verify that the default protocol is either TLS1.2 or TLS1.3.
    // No supported platform should default to an older protocol version.
    assert.eq(0, res["1.0"]);
    assert.eq(0, res["1.1"]);
    assert.eq(0, res["unknown"]);
    assert.neq(res["1.2"], res["1.3"]);

    if (res["1.2"].tojson() != NumberLong(0).tojson()) {
        return "TLS1_2";
    } else {
        return "TLS1_3";
    }
}

function isRHEL8() {
    if (_isWindows()) {
        return false;
    }

    // RHEL 8 disables TLS 1.0 and TLS 1.1 as part their default crypto policy
    // We skip tests on RHEL 8 that require these versions as a result.
    const grep_result = runProgram('grep', 'Ootpa', '/etc/redhat-release');
    if (grep_result == 0) {
        return true;
    }

    return false;
}

function isDebian10() {
    if (_isWindows()) {
        return false;
    }

    // Debian 10 disables TLS 1.0 and TLS 1.1 as part their default crypto policy
    // We skip tests on Debian 10 that require these versions as a result.
    try {
        // this file exists on systemd-based systems, necessary to avoid mischaracterizing debian
        // derivatives as stock debian
        const releaseFile = cat("/etc/os-release").toLowerCase();
        const prettyName = releaseFile.split('\n').find(function(line) {
            return line.startsWith("pretty_name");
        });
        return prettyName.includes("debian") &&
            (prettyName.includes("10") || prettyName.includes("buster") ||
             prettyName.includes("bullseye"));
    } catch (e) {
        return false;
    }
}

function sslProviderSupportsTLS1_0() {
    if (isRHEL8()) {
        const cryptoPolicy = cat("/etc/crypto-policies/config");
        return cryptoPolicy.includes("LEGACY");
    }
    return !isDebian10();
}

function sslProviderSupportsTLS1_1() {
    if (isRHEL8()) {
        const cryptoPolicy = cat("/etc/crypto-policies/config");
        return cryptoPolicy.includes("LEGACY");
    }
    return !isDebian10();
}

function opensslVersionAsInt() {
    const opensslInfo = getBuildInfo().openssl;
    if (!opensslInfo) {
        return null;
    }

    const matches = opensslInfo.running.match(/OpenSSL\s+(\d+)\.(\d+)\.(\d+)([a-z]?)/);
    assert.neq(matches, null);

    let version = (matches[1] << 24) | (matches[2] << 16) | (matches[3] << 8);

    return version;
}

function supportsStapling() {
    return opensslVersionAsInt() >= 0x01000200;
}
