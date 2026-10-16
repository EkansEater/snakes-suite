# Native code calls back into these by name.
-keepclasseswithmembernames class * { native <methods>; }
-keep class com.snake.suite.**.Native* { *; }
-keepattributes *Annotation*, InnerClasses
-dontwarn org.slf4j.**
# Python (Chaquopy) calls these by name.
-keep class com.snake.suite.mp3.Listener { *; }
