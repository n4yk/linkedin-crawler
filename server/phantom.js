//-------------------------------------------------------------------------------------//
// CONFIGURATION
//-------------------------------------------------------------------------------------//

var settings = {
    browserName: 'chrome',
    "phantomjs.page.settings.userAgent": 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/31.0.1650.26 Safari/537.36'
};

//-------------------------------------------------------------------------------------//
// LIBRARIES AND VARIABLES
//-------------------------------------------------------------------------------------//

var wd = Meteor.require('wd');
var Fiber = Npm.require('fibers');
var Asserter = wd.Asserter;
var browser = wd.remote('localhost', 9134);
var fs = Npm.require('fs');
var crawling = false;
var items = [];
var status = "";

//-------------------------------------------------------------------------------------//
// HELPERS
//-------------------------------------------------------------------------------------//

/**
 * Always true asserter
 * @type {Asserter}
 */
var asserter = new Asserter(
    function(target, cb) {
        cb(null, true, target);
    }
);

/**
 * Get a new session on LinkedIn
 * @param callback
 */
function newSession(callback) {
    browser.get("http://www.linkedin.com/", function() {
        browser.deleteAllCookies(function () {
            browser.refresh(function() {
                callback();
            });
        });
    });
}

/**
 * Fill in an input
 * @param selector {String}
 * @param text {String}
 * @param callback {Function}
 */
function input(selector, text, callback) {
    browser.elementByCssSelector(selector, function (err, el) {
        browser.type(el, text, callback);
    });
}

/**
 * Click on an item
 * @param selector {String}
 * @param callback {Function}
 */
function click(selector, callback) {
    browser.elementByCssSelector(selector, function (err, el) {
        el.click(callback);
    });
}

/**
 * Submit a form
 * @param selector {String}
 * @param callback {Function}
 */
function submit(selector, callback) {
    browser.elementByCssSelector(selector, function (err, el) {
        el.submit(callback);
    });
}

/**
 * Wait for an element
 * @param selector {String}
 * @param callback {Function}
 */
function waitFor(selector, callback) {
    browser.waitForElementByCssSelector(selector, asserter, 10000, 200, function (err, satis, el) {
        callback(err);
    });
}

/**
 * Create a screenshot
 * @param path {String}
 */
function screen(path) {
    browser.takeScreenshot(function (err, data) {
        fs.writeFileSync(path, data, 'base64');
    });
}

/**
 * Get the source code
 * @param selector {String} (default = body)
 * @param callback {Function}
 */
function source(selector, callback) {
    browser.execute(function () {return $(selector || 'body').html(); }, function (err, result) {
        callback(err ? false : result);
    });
}

/**
 * Notice some message
 * @param msg {string}
 */
function notice(msg) {
    status = msg;
    console.log(msg);
}

//-------------------------------------------------------------------------------------//
// FUNCTIONS INJECTED IN PHANTOM.JS WEBPAGE
//-------------------------------------------------------------------------------------//

/**
 * Extract search results from webpage
 * @returns {{ids: Array, next: boolean}}
 */
function getSearchResults() {
    var result = {ids: [], next: false},
        search = $("#results.search-results");

    $("li.result.people", search).each(function () {
        result.ids.push($(this).data("li-entity-id"));
    });

    result.next = $("#results-pagination li.next a").attr("href");
    return result;
}

/**
 * Get a User profile
 * @param callback
 */
function async_getUserResult(callback) {
    var result = {},
        $card = $("#top-card");

    if ($card.length) {
        result.name = $("span.full-name", $card).text();
        result.locality = $("#location .locality", $card).text();
        callback(result);
    } else {
        callback(false);
    }
}

//-------------------------------------------------------------------------------------//
// BUSINESS
//-------------------------------------------------------------------------------------//

/**
 * Signin to LinkedIn
 * @param email {String}
 * @param password {String}
 * @param callback {Function}
 */
function connect(email, password, callback) {
    notice("Connecting...");

    browser.init(settings, function() {
        newSession(function () {
            input("#session_key-login", email, function () {
                input("#session_password-login", password, function () {
                    submit("#login", function () {
                        waitFor(".nav-item.account-settings-tab", callback);
                    });
                });
            });
        });
    });
}

/**
 * Submit a new search
 */
function search(err) {
    if (err) {
        notice("Login failed. Search cancelled.");
        return;
    }

    notice("Searching...");

    browser.get("http://linkedin.com/vsearch/p?keywords=" + items.join("+"), function() {
        waitFor("#results.search-results", function () {
            getAllSearchResults(function (ids) {
                crawl(ids, function () {
                    notice("Crawl ends.");
                    crawling = false;
                });
            });
        });
    });
}

/**
 * Perform seach and save all results in the database.
 * @param callback {Function}
 * @param _result {Array} optional, only used in recursive call
 */
function getAllSearchResults(callback, _result) {
    _result = _result || [];
    browser.execute(getSearchResults, function (err, result) {
        if (result && result.ids && result.ids.length) {
            _result.push.apply(_result, result.ids);
        }
        if (result && result.next) {
            notice("Getting search results for page " + result.next.split("page_num=")[1] + "...");
            browser.get("http://www.linkedin.com" + result.next, function() {
                getAllSearchResults(callback, _result);
            });
        } else {
            notice("Search ends with " + _result.length + " result(s).");
            callback(_result);
        }
    });
}

/**
 * Crawl the users
 * @param ids {Array}
 * @param callback {Function}
 */
function crawl(ids, callback) {
    Fiber(function () {
        var id;
        var found = false;

        // Look for next id unknown.
        while (crawling && (id = ids.shift())) {
            if (!users.find({id: id}).count()) {
                console.log("New user. ID:" + id);
                found = true;
                break;
            }

            console.log("User already found. ID:" + id);
        }

        // If we've stopped crawling or we've finished with the list.
        if (!crawling || !found) {
            callback();
            return;
        }

        // Crawl this user.
        getUser(id, function () {
            crawl(ids, callback);
        });
    }).run();
}

/**
 * Get User data from LinkedIn
 * @param id {string}
 * @param callback {Function}
 */
function getUser(id, callback) {
    browser.get("http://www.linkedin.com/profile/view?id=" + id, function() {
        browser.executeAsync(async_getUserResult, function (err, result) {
            Fiber(function () {
                if (!err && result) {
                    notice("Saving " + result.name + "...");
                    result.id = id;
                    users.insert(result);
                } else {
                    console.log("Failed to view profile. ID:" + id);
                }

                callback();
            }).run();
        });
    });
}

//-------------------------------------------------------------------------------------//
// PUBLISH METHODS TO THE CLIENT
//-------------------------------------------------------------------------------------//

Meteor.methods({
    crawl: function (value, email, password, text) {
        this.unblock();
        crawling = value;
        items = (text || "").replace(/\s+/g, " ").split(" ");
        if (crawling) {
            connect(email, password, search);
        }
    },
    status: function () {
        return status;
    }
});
