FROM node:26-alpine3.23

RUN apk add --no-cache make

# Install packages into ./../node_modules
WORKDIR /src/iccqr/iccqr-site/..
ADD Prebuild.mk package.json package-lock.json ./
RUN make -f Prebuild.mk UPDATE_LOCK_FILE
RUN make -f Prebuild.mk INSTALL_DEPS

WORKDIR /src/iccqr/iccqr-site

CMD ["make", "SERVE"]
