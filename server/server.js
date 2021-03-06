/**
 *
 * ©2016-2017 EdgeVerve Systems Limited (a fully owned Infosys subsidiary),
 * Bangalore, India. All Rights Reserved.
 *
 */
/* eslint-disable no-console, no-process-exit */
/**
 * This is the main script which starts the server
 *
 * @module Server
 */
var preboot = require('../lib/preboot.js');
var loopback = require('loopback');
var boot = require('loopback-boot');
var async = require('async');
var _ = require('lodash');
var path = require('path');
var helmet = require('helmet');
var fs = require('fs');
var logger = require('../lib/logger');
var log = logger('Server');
var passport = require('../lib/passport.js');
var eventHistroyManager = require('../lib/event-history-manager.js');
var memoryPool = require('../lib/actor-pool.js');

var mergeUtil = require('../lib/merge-util');
var app = module.exports.loopback = loopback;
var options = {
  appRootDir: __dirname,
  appConfigRootDir: __dirname,
  modelsRootDir: __dirname,
  dsRootDir: __dirname,
  mixinDirs: [],
  bootDirs: [],
  clientAppRootDir: '',
  skipConfigurePassport: false
};

var mergeConfigJson = null;

options.bootDirs.push(path.join(__dirname, 'boot'));
module.exports.options = options;
preboot.injectOptions();

module.exports.boot = function serverBoot(appinstance, options, cb) {
  var env = options.env || process.env.NODE_ENV || 'development';
  // read the files from client and merge with files.
  // /starting with config.json.
  if (!appinstance.locals.apphome) {
    var msg = 'please set app.locals.apphome in your server.js before calling  boot.  (app.locals.apphome = _dirname;) ';
    console.error(msg);
    process.exit(1);
  }
  var appListPath = path.resolve(path.join(appinstance.locals.apphome, 'app-list.json'));
  var appListExists = fs.existsSync(appListPath) ? true : false;
  // helmet removes x-powered-by and add xss filters for security purpose
  appinstance.use(helmet());
  if (require.main !== module && appListExists) {
    var applist = require(appListPath);
    var dirname = options.clientAppRootDir;
    options = mergeUtil.loadAppList(applist, dirname, options);
    options.bootDirs.push(path.join(dirname, 'boot'));
    options.clientAppRootDir = dirname;
    finalBoot(appinstance, options, function finalBoot() {
      cb();
    });
  } else {
    async.parallel([async.apply(loadClientConfig, options, env),
      async.apply(loadClientModels, options, env),
      async.apply(loadClientDatasource, options, env),
      async.apply(loadClientMiddleware, options, env),
      async.apply(loadClientComponents, options, env)
    ],
      function serverBootAsyncParallelCb(err, results) {
        if (err) {
          cb(err);
        }
        finalBoot(appinstance, options, function finalBoot() {
          cb();
        });
      });
  }
};

function finalBoot(appinstance, options, cb) {
  module.exports.app = appinstance;

  appinstance.registry.modelBuilder.registerCustomType('timestamp', 'date');
  var emailPattern = '^(([^<>()[\\]\\\\.,;:\\s@\\"]+(\\.[^<>()[\\]\\\\.,;:\\s@\\"]+)*)|(\\".+\\"))@((\\[[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\])|(([a-zA-Z\\-0-9]+\\.)+[a-zA-Z]{2,}))$';
  appinstance.registry.modelBuilder.registerCustomType('email', 'string', { pattern: emailPattern });

  module.exports.relativePath = path.relative(options.appRootDir, path.resolve(options.clientAppRootDir, ''));
  var env = options.env || process.env.NODE_ENV || 'development';
  preboot.setSharedCtor(appinstance);

  // datasource merge done by loopback-boot doesnt suffice our requirements.
  if (require.main === module) {
    loadDatasource(options, env);
  }

  var server = require('http').createServer(appinstance);
  appinstance.server = server;
  module.exports.options = options;

  function bootWithMigrate(appinstance, options, cb) {
    boot(appinstance, options, function bootCbFn(err) {
      if (err) {
        return cb(err);
      }
      // db migrate and call back
      var dbm = require('../lib/db-migrate-helper.js');
      dbm(appinstance, options, cb);
    });
  }

  bootWithMigrate(appinstance, options, function serverFinalBootCb(err) {
    if (err) {
      throw err;
    }
    var configurePassport = true;
    if (options.skipConfigurePassport) {
      configurePassport = false;
    }
    var passportConfig;
    // passport can be configured by app rather than framework
    if (configurePassport) {
      passportConfig = passport.initPassport(appinstance);
    }
    // Atul : Overriding listen() - problem is loopbackapp.listen() would create server internally and there is no function/api available to seperate out. also ignore jshint
    // For node-red to work with same port.
    appinstance.listen = function appinstanceListen(cb) {
      var self = this;
      var server = this.server;
      server.on('listening', function serverListning() {
        self.set('port', this.address().port);

        var listeningOnAll = false;
        var host = self.get('host');
        if (!host) {
          listeningOnAll = true;
          host = this.address().address;
          self.set('host', host);
        } else if (host === '0.0.0.0' || host === '::') {
          listeningOnAll = true;
        }

        if (!self.get('url')) {
          if (process.platform === 'win32' && listeningOnAll) {
            // Windows browsers don't support `0.0.0.0` host in the URL
            // We are replacing it with localhost to build a URL
            // that can be copied and pasted into the browser.
            host = 'localhost';
          }
          var url = 'http://' + host + ':' + self.get('port') + '/';
          self.set('url', url);
        }
      });
      var useAppConfig = arguments.length === 0 ||
        (arguments.length === 1 && typeof arguments[0] === 'function');

      if (useAppConfig) {
        server.listen(this.get('port'), this.get('host'), cb);
      } else {
        server.listen.apply(server, arguments);
      }

      return server;
    };
    appinstance.start = function serverBootAppInstanceStartCb() {
      if (configurePassport) {
        passport.configurePassport(appinstance, passportConfig, options.providerJson);
      }
      // init global messaging
      require('../lib/common/global-messaging');
      // init memory pool
      memoryPool.initPool(appinstance);
      eventHistroyManager.init(appinstance);
      // start the web server
      return appinstance.listen(function serverBootAppInstanceListenCb() {
        appinstance.remotes().before('**', function appInstanceBeforeAll(ctx, next) {
          var allowedMethodList = appinstance.get('allowedHTTPMethods');
          var allowed = (!allowedMethodList || (allowedMethodList.indexOf(ctx.req.method) > -1));
          if (allowed) {
            next();
          } else {
            var err = new Error('Method not allowed');
            next(err);
          }
        });

        appinstance.remotes().before('**', function appInstanceBeforeAll(ctx, next) {
          if (ctx.instance) {
            ctx.instance.__remoteInvoked = true;
          }
          next();
        });

        appinstance.remotes().before('**', function appInstanceBeforeAll(ctx, next) {
          if (err) {
            return next(err);
          }
          var DataACL = loopback.getModelByType('DataACL');
          DataACL.applyFilter(ctx, next);
        });
        appinstance.remotes().after('**', function afterRemoteListner(ctx, next) {
          if (ctx.req.callContext && ctx.req.callContext.statusCode) {
            ctx.res.statusCode = ctx.req.callContext.statusCode;
          }
          next();
        });
        appinstance.frameworkBooted = true;
        appinstance.emit('started', appinstance);
        console.log('Web server listening at: %s', appinstance.get('url'));

        appinstance.get('remoting').errorHandler = {
          handler: function remotingErrorHandler(err, req, res, defaultHandler) {
            res.status(err.statusCode || err.status);
            var finalError = {};
            finalError.message = err.message || err.toString();
            var errors = [];
            errors = appinstance.buildError(err, req.callContext);
            finalError.txnId = req.callContext ? req.callContext.txnId : '';
            finalError.requestId = req.callContext ? req.callContext.requestId : '';
            finalError.errors = errors;
            log.error(options, 'error :', JSON.stringify(finalError));
            defaultHandler(finalError);
          }
        };

        appinstance.buildError = function appinstanceBuildError(err, context) {
          var errors = [];
          if (err instanceof Array) {
            // concat all errors to form a single error array
            Object.keys(err).forEach(function configLocalHandlerForEach(error) {
              var errorObj = err[error];
              if (errorObj.details && errorObj.details.messages.errs) {
                errors = errors.concat(errorObj.details.messages.errs);
              } else if (errorObj.details && errorObj.details.messages) {
                errors = errors.concat(errorObj.details.messages);
              } else {
                errors = errors.concat(errorObj);
              }
            });
          } else if (err.details && err.details.messages) {
            errors = err.details.messages.errs ? err.details.messages.errs : err.details.messages;
          } else {
            // single server error convert it to array of single error
            var errObj = {};
            errObj.code = err.code || err.errCode;
            errObj.message = err.message || err.errMessage;
            errObj.path = err.path;
            errors.push(errObj);
          }
          return errors;
        };
      });
    };
    return cb();
  });
}

module.exports.finalBootFn = finalBoot;

if (require.main === module) {
  var lbapp = app();
  // currently locals.apphome is used to know the location of providers.json configuration, same can be used for any other purpose
  // When any application uses this framework, it must set apphome variable in its boot directory
  lbapp.locals.apphome = __dirname;
  lbapp.locals.standAlone = true;
  finalBoot(lbapp, options, function frmworkFinalBoot() {
    lbapp.start();
  });
}

/**
 *
 * Function provides functionality to merge the config files.
 * It loads the app config files from the client app.
 * Loads the framework config files and merges the config.env file
 * with client config files and sets it to options.config.
 *
 * @param {object}options Initialize an application from an options object(loopback-boot options object).
 * @param {string}env Environment, usually `process.env.NODE_ENV`
 * @param {Function} callback Callback function
 * @function loadClientConfig
 */
function loadClientConfig(options, env, callback) {
  // Load the client config files.
  var clientconfig = boot.ConfigLoader.loadAppConfig(options.clientAppRootDir, env);

  // Read the framework's all config files.
  var config = mergeUtil.loadFiles(__dirname, env, 'config');
  if (config && config.length) {
    // Filter the list based on env.
    config = _.findLast(config, function serverLoadClientConfigFilterFn(d) {
      return (d._filename === path.resolve(__dirname, 'config.' + env + '.js') || d._filename === path.resolve(__dirname, 'config.' + env + '.json') || d._filename === path.resolve(__dirname, 'config.local.js') || d._filename === path.resolve(__dirname, 'config.local.json') || d._filename === path.resolve(__dirname, 'config.json'));
    });

    // Merge configs.
    mergeUtil.mergeFn(config, clientconfig);
  }
  options.config = config;
  callback();
}

/**
 * Function provides functionality to merge the model-config files.
 * It loads the app model-config files from the client app.
 * Loads the framework's model-config files and merges the model-config.env file
 * with client model-config files and sets it to options.models.
 *
 * @param {object}options Initialize an application from an options object(loopback-boot options object).
 * @param {string}env Environment, usually `process.env.NODE_ENV`
 * @param {Function} callback Callback function
 * @function loadClientModels
 */
function loadClientModels(options, env, callback) {
  // Load the client model-config files.
  var clientmodels = boot.ConfigLoader.loadModels(options.clientAppRootDir, env);

  function modifyPath(element) {
    if (element.indexOf('../') === 0) {
      return path.relative(options.appRootDir, path.resolve('../', options.clientAppRootDir, element));
    } else if (element.indexOf('./') === 0) {
      return path.relative(options.appRootDir, path.resolve(options.clientAppRootDir, element));
    }
    return element;
  }
  if (clientmodels._meta && clientmodels._meta.sources) {
    clientmodels._meta.sources = _.map(clientmodels._meta.sources, modifyPath);
  }
  if (clientmodels._meta && clientmodels._meta.mixins) {
    clientmodels._meta.mixins = _.map(clientmodels._meta.mixins, modifyPath);
  }

  // Read the framework's all model-config files.
  var modelConfig = mergeUtil.loadFiles(__dirname, env, 'model-config');
  if (modelConfig && modelConfig.length) {
    // Filter the list based on env.
    modelConfig = _.findLast(modelConfig, function serverLoadClientModelsConfigFn(d) {
      return (d._filename === path.resolve(__dirname, 'model-config.' + env + '.js') || d._filename === path.resolve(__dirname, 'model-config.' + env + '.json') || d._filename === path.resolve(__dirname, 'model-config.local.js') || d._filename === path.resolve(__dirname, 'model-config.local.json') || d._filename === path.resolve(__dirname, 'model-config.json'));
    });

    // Merge configs.
    mergeUtil.mergeFn(modelConfig, clientmodels);
  }
  options.models = modelConfig;
  callback();
}

/**
 * Function provides functionality to merge the dataSources files.
 * It loads the app dataSources files from the client app.
 * Loads the framework dataSources files and merges the dataSources.env file
 * with client dataSources files and sets it to options.dataSources.
 *
 * @param {object}options Initialize an application from an options object(loopback-boot options object).
 * @param {string}env Environment, usually `process.env.NODE_ENV`
 * @param {Function} callback Callback function
 * @function loadClientDatasource
 */
function loadClientDatasource(options, env, callback) {
  // Load the client datasources files.
  var clientdatasource = mergeUtil.loadDataSources(options.clientAppRootDir, env);

  // Read the framework's all datasources files.
  var datasource = mergeUtil.loadFiles(__dirname, env, 'datasources');
  if (datasource && datasource.length) {
    // Filter the list based on env.
    datasource = _.findLast(datasource, function serverLoadClientDatasourceFn(d) {
      return (d._filename === path.resolve(__dirname, 'datasources.' + env + '.js') || d._filename === path.resolve(__dirname, 'datasources.' + env + '.json') || d._filename === path.resolve(__dirname, 'datasources.local.js') || d._filename === path.resolve(__dirname, 'datasources.local.json') || d._filename === path.resolve(__dirname, 'datasources.json'));
    });

    // Merge configs.
    mergeUtil.mergeDataSourcesObjects(datasource, clientdatasource);
  }

  options.dataSources = datasource;
  callback();
}

/**
 * Function to call mergeUtil's loadDataSources method when booted from
 * main app and set options.datasources.
 *
 * @param {object}options Initialize an application from an options object(loopback-boot options object).
 * @param {string}env - environment variable
 * @function loadDatasource
 */
function loadDatasource(options, env) {
  var datasource = mergeUtil.loadDataSources(options.appRootDir, env);
  options.dataSources = datasource;
}

/**
 * Function provides functionality to merge the Middleware files.
 * It loads the app Middleware files from the client app.
 * Loads the framework Middleware files and merges the Middleware.env file
 * with client Middleware files and sets it to options.Middleware.
 *
 * @param {object}options Initialize an application from an options object(loopback-boot options object).
 * @param {string}env Environment, usually `process.env.NODE_ENV`
 * @param {Function} callback Callback function
 * @function loadClientMiddleware
 */
function loadClientMiddleware(options, env, callback) {
  // change the client path.
  var relativeServerPath = replaceAll(path.relative(options.appRootDir, options.clientAppRootDir), '\\', '/') + '/';
  var relativePath = replaceAll(path.relative(options.appRootDir, ''), '\\', '/') + '/';

  function escapeRegExp(str) {
    return str.replace(/([.*+?^=!:${}()\[\]\/\\])/g, '\\$1');
  }

  function replaceAll(str, find, replace) {
    return str.replace(new RegExp(escapeRegExp(find), 'g'), replace);
  }

  // Load the client middleware files.
  var clientmiddleware = boot.ConfigLoader.loadMiddleware(options.clientAppRootDir, env);
  var temp = '<dummy>';
  if (clientmiddleware) {
    var tempmiddleware = replaceAll(JSON.stringify(clientmiddleware), '../', temp);
    tempmiddleware = replaceAll(tempmiddleware, './', relativeServerPath);
    clientmiddleware = JSON.parse(replaceAll(tempmiddleware, temp, relativePath));
  }

  // Read the framework's all middleware files.
  var middleware = mergeUtil.loadFiles(__dirname, env, 'middleware');
  if (middleware && middleware.length) {
    // Filter the list based on env.
    middleware = _.findLast(middleware, function serverLoadClientMiddlewareFn(d) {
      return (d._filename === path.resolve(__dirname, 'middleware.' + env + '.js') || d._filename === path.resolve(__dirname, 'middleware.' + env + '.json') || d._filename === path.resolve(__dirname, 'middleware.local.js') || d._filename === path.resolve(__dirname, 'middleware.local.json') || d._filename === path.resolve(__dirname, 'middleware.json'));
    });

    // Merge configs.
    mergeUtil.mergeMiddlewareConfig(middleware, clientmiddleware);
  }
  options.middleware = middleware;
  callback();
}

/**
 * Function provides functionality to merge the Components files.
 * It loads the app Components files from the client app.
 * Loads the framework Components files and merges the Components.env file
 * with client Components files and sets it to options.Components.
 *
 * @param {object}options Initialize an application from an options object(loopback-boot options object).
 * @param {string}env Environment, usually `process.env.NODE_ENV`
 * @param {Function} callback Callback function
 * @function loadClientComponents
 */
function loadClientComponents(options, env, callback) {
  // Load the client component-config files.
  var clientcomponents = boot.ConfigLoader.loadComponents(options.clientAppRootDir, env);

  // Read the framework's all component-config files.
  var component = mergeUtil.loadFiles(__dirname, env, 'component-config');
  if (component && component.length) {
    // Filter the list based on env.
    component = _.findLast(component, function serverLoadClientComponentsFn(d) {
      return (d._filename === path.resolve(__dirname, 'component-config.' + env + '.js') || d._filename === path.resolve(__dirname, 'component-config.' + env + '.json') || d._filename === path.resolve(__dirname, 'component-config.local.js') || d._filename === path.resolve(__dirname, 'component-config.local.json') || d._filename === path.resolve(__dirname, 'component-config.json'));
    });

    // Merge configs.
    mergeUtil.mergeFn(component, clientcomponents);
  }
  options.components = component;
  callback();
}


/**
 * Function to load modules installed in node_modules of app.
 * @param {string}appRootPath - App root path
 * @param {string} filePath - file path
 * @param {function} callback - callback fn
 */
module.exports.loadOptionsFromConfig = function loadOptionsFromConfig(appRootPath, filePath, callback) {
  fs.stat(filePath, function fsStat(err, stats) {
    if (err) { callback(err); } else if (stats.isFile()) {
      var cwd = __dirname;
      var nodeModules = path.join(cwd, '../../');
      var serverSuffix = 'server';
      var bootSuffix = 'server/boot';
      mergeConfigJson = require(filePath);
      // Push client's root path and boot path
      options.clientAppRootDirList.push(appRootPath);
      options.bootDirs.push(path.join(appRootPath, 'boot'));

      // Push all other apps root bath and boot path
      var applist = mergeConfigJson.applist;
      async.each(
        applist,
        function appItemEach(appitem) {
          if (appitem.enabled) {
            var appRoot = path.join(nodeModules, appitem.name, serverSuffix);
            var bootRoot = path.join(nodeModules, appitem.name, bootSuffix);
            try {
              fs.accessSync(appRoot, fs.F_OK);
              fs.accessSync(bootRoot, fs.F_OK);
              options.clientAppRootDirList.push(appRoot);
              options.bootDirs.push(bootRoot);
            } catch (e) {
              console.log('[ERROR] Invalid path for app merge');
            }
          }
        },
        function asyncFinalCallback(err) {
          if (err) {
            callback(err);
          }
        }
      );
      callback(null);
    }
  });
};
