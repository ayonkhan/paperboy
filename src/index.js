import template from '../templates/new-post.html';

export default {
    async scheduled(event, env, ctx) {
        ctx.waitUntil(checkFeed(env));
    }
};

// Settings the Worker can't run without
var REQUIRED = ['RESEND_API_KEY', 'FEED_URL', 'FROM_EMAIL', 'SEGMENT_ID', 'SITE_NAME', 'SITE_URL'];

async function checkFeed(env) {
    var missing = REQUIRED.filter(function (name) { return !env[name]; });
    if (missing.length) {
        throw new Error('Missing settings: ' + missing.join(', '));
    }

    var xml = await fetch(env.FEED_URL).then(function (response) { return response.text(); });
    var post = latestPost(xml, env);
    if (!post) return;

    var lastSent = await env.SENT_POSTS.get('last-sent');
    if (lastSent === post.link) return;

    // On the very first run, remember the latest post without emailing it
    if (lastSent === null) {
        await env.SENT_POSTS.put('last-sent', post.link);
        return;
    }

    var response = await fetch('https://api.resend.com/broadcasts', {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + env.RESEND_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            // Only shown in the Resend dashboard, so each broadcast is easy to find
            name: shorten(post.title, 70),
            segment_id: env.SEGMENT_ID,
            from: env.FROM_EMAIL,
            reply_to: env.REPLY_TO,
            subject: 'New post: ' + post.title,
            html: fill(template, {
                title: post.title,
                link: post.link,
                description: post.description,
                date: post.date,
                site_name: env.SITE_NAME,
                site_url: env.SITE_URL
            }),
            send: true,
            // Gives you time to check the email and cancel it in Resend
            scheduled_at: sendTime(env)
        })
    });

    if (!response.ok) {
        throw new Error('Resend returned ' + response.status + ': ' + await response.text());
    }
    await env.SENT_POSTS.put('last-sent', post.link);
}

// SEND_DELAY_HOURS sets how long to wait before sending: 2 by default, 0 to send right away
function sendTime(env) {
    var hours = env.SEND_DELAY_HOURS === undefined || env.SEND_DELAY_HOURS === '' ? 2 : Number(env.SEND_DELAY_HOURS);
    if (isNaN(hours) || hours < 0) {
        throw new Error('SEND_DELAY_HOURS must be a number of hours, such as 2 or 0.5');
    }
    // Leaving scheduled_at out makes Resend send straight away
    if (hours === 0) return undefined;
    return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

// Picks the post with the newest date. Most feeds list it first, but not all of
// them do, so the order in the feed isn't trusted. If no post has a valid date,
// the first one is used.
function latestPost(xml, env) {
    var items = xml.match(/<item>[\s\S]*?<\/item>/g);
    if (!items) return null;

    var item = items[0];
    var date = new Date(tag(item, 'pubDate'));
    items.forEach(function (other) {
        var otherDate = new Date(tag(other, 'pubDate'));
        if (otherDate > date || isNaN(date)) {
            item = other;
            date = otherDate;
        }
    });

    return {
        title: tag(item, 'title'),
        link: tag(item, 'link'),
        // The description is escaped HTML, so decode it once more and strip the tags
        description: decode(tag(item, 'description')).replace(/<[^>]+>/g, '').trim(),
        // Shown in the email as "7 November 2026", or however DATE_LOCALE writes it
        date: date.toLocaleDateString(env.DATE_LOCALE || 'en-GB', {
            day: 'numeric', month: 'long', year: 'numeric', timeZone: env.TIME_ZONE || 'UTC'
        })
    };
}

// Resend allows broadcast names of up to 70 characters, so longer titles are
// cut short with an ellipsis. Array.from counts emoji as one character each.
function shorten(text, max) {
    var characters = Array.from(text);
    if (characters.length <= max) return text;
    return characters.slice(0, max - 1).join('') + '…';
}

function tag(xml, name) {
    var match = xml.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>'));
    if (!match) return '';
    // Text inside <![CDATA[...]]> is used as it is, without decoding
    var cdata = match[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    return cdata ? cdata[1] : decode(match[1]);
}

function decode(text) {
    return text
        .replace(/&#(\d+);/g, function (match, code) { return String.fromCodePoint(code); })
        .replace(/&#x([0-9a-f]+);/gi, function (match, code) { return String.fromCodePoint(parseInt(code, 16)); })
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&rsquo;/g, '’')
        .replace(/&amp;/g, '&');
}

function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Uses %%name%% placeholders, so they never clash with Resend's {{{...}}} ones
function fill(html, values) {
    return html.replace(/%%(\w+)%%/g, function (match, name) {
        return escapeHtml(values[name] || '');
    });
}
