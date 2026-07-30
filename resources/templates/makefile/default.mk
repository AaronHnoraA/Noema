CC ?= cc
CFLAGS ?= -Wall -Wextra -Werror -std=c11 -g
CPPFLAGS ?=
LDFLAGS ?=
LDLIBS ?=

TARGET ?= app
SRC := $(wildcard *.c)
OBJ := $(SRC:.c=.o)

.PHONY: all clean run

all: $(TARGET)

$(TARGET): $(OBJ)
	$(CC) $(LDFLAGS) -o $@ $^ $(LDLIBS)

%.o: %.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -c -o $@ $<

run: $(TARGET)
	./$(TARGET)

clean:
	rm -f $(TARGET) $(OBJ)

