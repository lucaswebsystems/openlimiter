# OpenLimiter 2.1.2

The desktop no longer repeats the "usage window reset" alert every second. A reset alert now needs the window end to move forward by at least a minute, and a source still reporting an earlier window end is ignored, so two sources reporting the same Claude session window a few seconds apart no longer count as a new window.
