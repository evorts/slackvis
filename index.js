/**
 * author: steven
 * date: 7/6/17
 */
let RtmClient    = require('@slack/client').RtmClient;
let ClientEvents = require('@slack/client').CLIENT_EVENTS;
let RtmEvents    = require('@slack/client').RTM_EVENTS;
let fs           = require('fs');
let rmDir        = require('rimraf');

let validator = {
    length    : function (value, params) {
        return this.notEmpty(value) && value.length >= params.min && value.length <= params.max;
    },
    notEmpty  : function (value) {
        return !(typeof value === "undefined" 
                    || value === null
                    || ((typeof value).toLowerCase().indexOf("string") > -1 && value.trim().length < 1) 
                    || ((typeof value).toLowerCase().indexOf("number") > -1 && (value < 1 || isNaN(value)))
        );
    },
    empty     : function (value) {
        return !this.notEmpty(value);
    },
    dateObject: function (value) {
        return Object.prototype.toString.call(value) === '[object Date]';
    },
    isArray   : function (value) {
        return Array.isArray(value);
    },
    isString  : function (value) {
        return (typeof value).toLowerCase().indexOf("string") > -1;
    },
    isObject  : function (value) {
        return typeof value === "object";
    }
};

let config = {
    bot   : {
        token      : process.env.SLACK_BOT_TOKEN || '',
        restriction: {
            channels: ['autobot'] //restrict bot into certain channel
        }
    },
    action: {
        cleanup: {
            web   : {
                baseDir: process.env.BOT_CLEANUP_DIR_WEB || ''
            },
            mobile: {
                baseDir: process.env.BOT_CLEANUP_DIR_MOBILE || ''
            }
        }
    }
};

let rtm = new RtmClient(config.bot.token);

let slack = {
    bot     : {
        id        : '', //fill this id when connected
        name      : process.env.SLACK_BOT_NAME || 'maeda',
        channels  : [],
        channelIds: [],
        team      : undefined
    },
    users   : {},
    messages: {
        welcome             : `{{BOT_NAME}} here! at your service!!`,
        help                : `
_Hello there! for your information, I can process commands as follow:_ \n
\`cleanup &lt;context&gt; &lt;branch/ticket&gt;\`\n
_*context*:_ \`web|mobile\`\n
_*branch/ticket*:_ \`branch name or ticket number\` _can be multiple separate by &lt;space&gt;_
`,
        incorrectCommand    : `<@{{USER_ID}}|{{USER_NAME}}>_!_\n _please ensure you give me the correct command pattern._\n\n----\n\n`,
        commandNotRecognised: `_I could not recognise your intention! please try another command or type help._`,
        hello               : `{{GREET}} juga <@{{USER_ID}}|{{USER_NAME}}>! :smile:`,
        pong                : 'PONG!',
        processing          : '_Hi <@{{USER_ID}}|{{USER_NAME}}>,_\n_Your request is being processed. Please wait..._ :sunglasses:',
        processCompleted    : '<@{{USER_ID}}|{{USER_NAME}}>_, your request for_ \`{{ACTION}}\` _has been *completed*!_',
        succeed             : `<@{{USER_ID}}|{{USER_NAME}}>_,_ \`{{ACTION}}\` for \`{{CONTEXT}}\` success!`,
        prohibit            : `<@{{USER_ID}}|{{USER_NAME}}>_, it's prohibit to_ \`{{ACTION}}\` _for_ \`{{CONTEXT}}\``,
        notExist            : `<@{{USER_ID}}|{{USER_NAME}}>_, could not do \`{{ACTION}}\` since \`{{CONTEXT}}\` does not exist!_`
    },
    notify  : function (message) {
        if (typeof this.bot.channels !== "undefined") {
            if (this.bot.channels.length > 0) {
                this.bot.channels.forEach(function (channel) {
                    rtm.sendMessage(message, channel.id);
                });
            }
        }
    }
};

rtm.on(ClientEvents.RTM.AUTHENTICATED, function (rtmData) {
    //complete bot profile
    for (const user of rtmData.users) {
        if (user.name === slack.bot.name) {
            slack.bot.id = user.id;
        }
        slack.users[user.id] = {
            id  : user.id,
            name: user.name
        }
    }

    //init channel
    for (const channel of rtmData.channels) {
        if (channel.is_member) {
            if (config.bot.restriction.channels.length > 0) {
                if (config.bot.restriction.channels.indexOf(channel.name) > -1) {
                    slack.bot.channels.push(channel);
                    slack.bot.channelIds.push(channel.id);
                } else {
                    //do nothing
                }
            } else {
                slack.bot.channels.push(channel);
                slack.bot.channelIds.push(channel.id);
            }
        }
    }

    //init teams
    slack.bot.team = {
        id  : rtmData.team.id,
        name: rtmData.team.name
    };

    console.log(`Logged in as ${rtmData.self.name} of team ${rtmData.team.name}`);
});

// you need to wait for the client to fully connect before you can send messages
rtm.on(ClientEvents.RTM.RTM_CONNECTION_OPENED, function () {
    slack.notify(slack.messages.welcome.replace('{{BOT_NAME}}', slack.bot.name));
});

let doMessageHandling = function (message) {
    //check whether bot are mentioned
    if (message.type === 'message'
        && message.team === slack.bot.team.id
        && slack.bot.channelIds.indexOf(message.channel) > -1) {

        let mentionedUser = message.text.replace(/(\<.+\>\s?)(.*)/gi, '$1');

        //ensure only handled when mentioned
        if (mentionedUser.indexOf(slack.bot.id) > -1) {
            //only process certain message without subtype
            if (typeof message['subtype'] !== "undefined") {
                console.log('>>> Message Sub Type: ' + message['subtype']);
            } else {
                //this would be the correct message area
                let textMessage = message.text.substr(mentionedUser.length);

                //identify the command and arguments by separating the space
                let commands = textMessage.trim().split(' ');

                //only process commands
                if (commands.length > 0) {
                    let command = commands[0].toLowerCase();
                    let args    = commands.slice(1);

                    if (command === 'help') {
                        slack.notify(slack.messages.help);
                    } else if (command === 'cleanup') {
                        //only proceed when there's supported argument indicate which context should be cleanup
                        //in this case it would be by ticket/branch naming
                        if (args.length > 1) {
                            slack.notify(
                                slack.messages.processing
                                    .replace('{{USER_ID}}', message.user)
                                    .replace('{{USER_NAME}}', slack.users[message.user].name)
                            );

                            let context = args[0];
                            let baseDir = config.action.cleanup.web.baseDir;

                            if (context === 'mobile') {
                                baseDir = config.action.cleanup.mobile.baseDir;
                            }

                            args = args.splice(1);

                            let successRemoval = [];

                            args.forEach(function (val) {
                                //avoid deleting sensitive directory
                                if (validator.notEmpty(val) && ['current', 'releases', 'repo', 'shared'].indexOf(val) === -1) {
                                    //check if directory exist
                                    let dir = baseDir + val;

                                    if (fs.existsSync(dir)) {
                                        successRemoval.push(val);
                                        rmDir(dir, function (error) {
                                            successRemoval.splice(val, 1);
                                            console.log('>>> Error remove directory: ' + dir);
                                            console.log(error);
                                        });
                                    } else {
                                        slack.notify(
                                            slack.messages.notExist
                                                .replace('{{USER_ID}}', message.user)
                                                .replace('{{USER_NAME}}', slack.users[message.user].name)
                                                .replace('{{ACTION}}', command + ' ' + context + ' ' + val)
                                                .replace('{{CONTEXT}}', val)
                                        );
                                    }
                                } else {
                                    slack.notify(
                                        slack.messages.prohibit
                                            .replace('{{USER_ID}}', message.user)
                                            .replace('{{USER_NAME}}', slack.users[message.user].name)
                                            .replace('{{ACTION}}', command + ' ' + context)
                                            .replace('{{CONTEXT}}', val)
                                    );
                                }
                            });

                            slack.notify(
                                slack.messages.processCompleted
                                    .replace('{{USER_ID}}', message.user)
                                    .replace('{{USER_NAME}}', slack.users[message.user].name)
                                    .replace('{{ACTION}}', command + ' ' + context) + `\n_Successful:_ *` + successRemoval.join(',') + '*'
                            );
                        } else {
                            slack.notify(
                                slack.messages.incorrectCommand
                                    .replace('{{USER_ID}}', message.user)
                                    .replace('{{USER_NAME}}', slack.users[message.user].name)
                                + slack.messages.help
                            );
                        }
                    } else if (['hello', 'hi', 'hai', 'hei'].indexOf(command) > -1) {
                        slack.notify(
                            slack.messages.hello
                                .replace('{{GREET}}', command)
                                .replace('{{USER_ID}}', message.user)
                                .replace('{{USER_NAME}}', slack.users[message.user].name)
                        );
                    } else if (command === 'ping') {
                        slack.notify(slack.messages.pong);
                    } else {
                        slack.notify(slack.messages.commandNotRecognised);
                    }
                }
            }
        }

    }
};

rtm.on(RtmEvents.MESSAGE, function handleRtmMessage(message) {
    doMessageHandling(message);
});

process.on('unhandledRejection', function (err) {
    throw err;
});

process.on('uncaughtException', function (err) {
    console.log(err);
});

rtm.start();